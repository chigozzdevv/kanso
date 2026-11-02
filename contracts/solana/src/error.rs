use solana_program::program_error::ProgramError;
#[derive(Clone, Copy, Debug)]
#[repr(u32)]
pub enum VaultError {
    InvalidAccount = 1,
    Unauthorized,
    InvalidCommand,
    NonceMismatch,
    Expired,
    InsufficientCollateral,
    DuplicateOperation,
    InvalidDeposit,
}
impl From<VaultError> for ProgramError {
    fn from(error: VaultError) -> Self {
        Self::Custom(error as u32)
    }
}
