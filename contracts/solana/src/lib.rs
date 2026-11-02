#![allow(unexpected_cfgs)]
pub mod error;
pub mod instruction;
pub mod state;
mod vault;
use borsh::BorshDeserialize;
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let instruction = instruction::VaultInstruction::try_from_slice(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    vault::process(program_id, accounts, instruction)
}
