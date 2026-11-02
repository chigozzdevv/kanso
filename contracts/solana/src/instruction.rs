use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub enum VaultInstruction {
    Initialize {
        deployment: [u8; 32],
        network: [u8; 32],
        controller: [u8; 32],
    },
    Deposit {
        lock_id: [u8; 32],
        agreement: [u8; 32],
        borrower: [u8; 32],
        leg_id: [u8; 32],
        refund_recipient: [u8; 32],
        purpose: u8,
        amount: u64,
    },
    Execute(Command),
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct Command {
    pub operation_id: [u8; 32],
    pub lock_id: [u8; 32],
    pub agreement: [u8; 32],
    pub settlement_id: [u8; 32],
    pub recipient: [u8; 32],
    pub amount: u64,
    pub nonce: u64,
    pub deadline: u64,
    pub kind: u8,
    pub max_receipt_rent: u64,
}
