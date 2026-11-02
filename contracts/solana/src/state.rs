use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub tag: [u8; 8],
    pub deployment: [u8; 32],
    pub network: [u8; 32],
    pub controller: [u8; 32],
}
impl Config {
    pub const SIZE: usize = 104;
    pub const TAG: [u8; 8] = *b"KANSOCFG";
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Lock {
    pub tag: [u8; 8],
    pub config: [u8; 32],
    pub lock_id: [u8; 32],
    pub agreement: [u8; 32],
    pub borrower: [u8; 32],
    pub leg_id: [u8; 32],
    pub owner: [u8; 32],
    pub refund_recipient: [u8; 32],
    pub purpose: u8,
    pub deposited: u64,
    pub remaining: u64,
    pub nonce: u64,
}
impl Lock {
    pub const SIZE: usize = 257;
    pub const TAG: [u8; 8] = *b"KANSOLOK";
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Receipt {
    pub tag: [u8; 8],
    pub config: [u8; 32],
    pub operation_id: [u8; 32],
    pub lock_id: [u8; 32],
    pub agreement: [u8; 32],
    pub settlement_id: [u8; 32],
    pub recipient: [u8; 32],
    pub amount: u64,
    pub remaining: u64,
    pub nonce: u64,
    pub kind: u8,
}
impl Receipt {
    pub const SIZE: usize = 225;
    pub const TAG: [u8; 8] = *b"KANSORCP";
}
