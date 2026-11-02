use crate::{
    error::VaultError as E,
    instruction::VaultInstruction,
    state::{Config, Lock, Receipt},
};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::{
    instruction::{allocate, assign, create_account, transfer},
    program::ID as SYSTEM,
};

fn require(condition: bool, error: E) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        Err(error.into())
    }
}
fn read<T: BorshDeserialize>(account: &AccountInfo, program: &Pubkey) -> Result<T, ProgramError> {
    require(account.owner == program, E::InvalidAccount)?;
    T::try_from_slice(&account.try_borrow_data()?).map_err(|_| E::InvalidAccount.into())
}
fn write<T: BorshSerialize>(account: &AccountInfo, state: &T) -> ProgramResult {
    state
        .serialize(&mut &mut account.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}
fn create<'a>(
    program: &Pubkey,
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    space: usize,
    principal: u64,
) -> ProgramResult {
    require(
        payer.is_signer && payer.is_writable && target.is_writable && system.key == &SYSTEM,
        E::InvalidAccount,
    )?;
    require(
        target.data_is_empty() && target.owner == &SYSTEM,
        E::DuplicateOperation,
    )?;
    let (address, bump) = Pubkey::find_program_address(seeds, program);
    require(target.key == &address, E::InvalidAccount)?;
    let bump_seed = [bump];
    let mut signing_seeds = seeds.to_vec();
    signing_seeds.push(&bump_seed);
    let lamports = Rent::get()?
        .minimum_balance(space)
        .checked_add(principal)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if target.lamports() == 0 {
        invoke_signed(
            &create_account(payer.key, target.key, lamports, space as u64, program),
            &[payer.clone(), target.clone(), system.clone()],
            &[&signing_seeds],
        )
    } else {
        let required = lamports.saturating_sub(target.lamports());
        if required > 0 {
            invoke(
                &transfer(payer.key, target.key, required),
                &[payer.clone(), target.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &allocate(target.key, space as u64),
            &[target.clone(), system.clone()],
            &[&signing_seeds],
        )?;
        invoke_signed(
            &assign(target.key, program),
            &[target.clone(), system.clone()],
            &[&signing_seeds],
        )
    }
}

pub fn process(
    program: &Pubkey,
    accounts: &[AccountInfo],
    instruction: VaultInstruction,
) -> ProgramResult {
    match instruction {
        VaultInstruction::Initialize {
            deployment,
            network,
            controller,
        } => {
            let [config, payer, system] = accounts else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            require(
                deployment != [0; 32]
                    && network != [0; 32]
                    && controller != [0; 32]
                    && controller != program.to_bytes(),
                E::InvalidDeposit,
            )?;
            create(
                program,
                payer,
                config,
                system,
                &[b"config", &deployment, &controller],
                Config::SIZE,
                0,
            )?;
            write(
                config,
                &Config {
                    tag: Config::TAG,
                    deployment,
                    network,
                    controller,
                },
            )
        }
        VaultInstruction::Deposit {
            lock_id,
            agreement,
            borrower,
            leg_id,
            refund_recipient,
            purpose,
            amount,
        } => {
            let [config_account, lock_account, owner, system] = accounts else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            let config: Config = read(config_account, program)?;
            require(
                config.tag == Config::TAG
                    && lock_id != [0; 32]
                    && agreement != [0; 32]
                    && borrower != [0; 32]
                    && leg_id != [0; 32]
                    && refund_recipient != [0; 32]
                    && purpose <= 1
                    && amount > 0,
                E::InvalidDeposit,
            )?;
            require(
                refund_recipient != lock_account.key.to_bytes() && owner.key != lock_account.key,
                E::InvalidDeposit,
            )?;
            create(
                program,
                owner,
                lock_account,
                system,
                &[b"lock", config_account.key.as_ref(), &lock_id],
                Lock::SIZE,
                amount,
            )?;
            write(
                lock_account,
                &Lock {
                    tag: Lock::TAG,
                    config: config_account.key.to_bytes(),
                    lock_id,
                    agreement,
                    borrower,
                    leg_id,
                    owner: owner.key.to_bytes(),
                    refund_recipient,
                    purpose,
                    deposited: amount,
                    remaining: amount,
                    nonce: 0,
                },
            )
        }
        VaultInstruction::Execute(command) => {
            let [config_account, lock_account, receipt_account, controller, payer, recipient, system] =
                accounts
            else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            let config: Config = read(config_account, program)?;
            let mut lock: Lock = read(lock_account, program)?;
            require(
                config.tag == Config::TAG
                    && controller.is_signer
                    && controller.key.to_bytes() == config.controller,
                E::Unauthorized,
            )?;
            require(
                lock.tag == Lock::TAG
                    && lock.config == config_account.key.to_bytes()
                    && lock.lock_id == command.lock_id
                    && lock.agreement == command.agreement,
                E::InvalidAccount,
            )?;
            let (lock_address, _) = Pubkey::find_program_address(
                &[b"lock", config_account.key.as_ref(), &command.lock_id],
                program,
            );
            require(
                lock_account.key == &lock_address
                    && lock_account.is_writable
                    && recipient.is_writable
                    && recipient.key.to_bytes() == command.recipient
                    && recipient.key != lock_account.key
                    && recipient.key != receipt_account.key,
                E::InvalidAccount,
            )?;
            require(
                command.operation_id != [0; 32] && command.kind <= 2,
                E::InvalidCommand,
            )?;
            require(command.nonce == lock.nonce, E::NonceMismatch)?;
            let now = u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| E::Expired)?;
            require(now <= command.deadline, E::Expired)?;
            if command.kind == 2 {
                require(
                    command.amount == 0
                        && command.recipient == [0; 32]
                        && command.settlement_id == [0; 32],
                    E::InvalidCommand,
                )?;
            } else {
                require(
                    command.amount > 0
                        && command.recipient != [0; 32]
                        && (command.kind == 1) == (command.settlement_id != [0; 32]),
                    E::InvalidCommand,
                )?;
                require(command.amount <= lock.remaining, E::InsufficientCollateral)?;
            }
            require(
                Rent::get()?.minimum_balance(Receipt::SIZE) <= command.max_receipt_rent,
                E::InvalidCommand,
            )?;
            create(
                program,
                payer,
                receipt_account,
                system,
                &[
                    b"receipt",
                    config_account.key.as_ref(),
                    &command.operation_id,
                ],
                Receipt::SIZE,
                0,
            )?;
            lock.remaining = lock
                .remaining
                .checked_sub(command.amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            lock.nonce = lock
                .nonce
                .checked_add(1)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            require(
                lock_account.lamports()
                    >= Rent::get()?
                        .minimum_balance(Lock::SIZE)
                        .checked_add(lock.remaining)
                        .ok_or(ProgramError::ArithmeticOverflow)?
                        .checked_add(command.amount)
                        .ok_or(ProgramError::ArithmeticOverflow)?,
                E::InsufficientCollateral,
            )?;
            if command.amount > 0 {
                let recipient_after = recipient
                    .lamports()
                    .checked_add(command.amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                **lock_account.try_borrow_mut_lamports()? -= command.amount;
                **recipient.try_borrow_mut_lamports()? = recipient_after;
            }
            write(lock_account, &lock)?;
            write(
                receipt_account,
                &Receipt {
                    tag: Receipt::TAG,
                    config: config_account.key.to_bytes(),
                    operation_id: command.operation_id,
                    lock_id: command.lock_id,
                    agreement: command.agreement,
                    settlement_id: command.settlement_id,
                    recipient: command.recipient,
                    amount: command.amount,
                    remaining: lock.remaining,
                    nonce: command.nonce,
                    kind: command.kind,
                },
            )
        }
    }
}
