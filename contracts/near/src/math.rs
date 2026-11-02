use ethnum::U256;

pub const YEAR_SECONDS: u64 = 31_536_000;
pub const INTEREST_DENOMINATOR: u64 = 10_000 * YEAR_SECONDS;
pub const NEAR_SCALE: u128 = 1_000_000_000_000_000_000_000_000;

fn amount(value: U256) -> u128 {
    value.try_into().expect("AMOUNT_OVERFLOW")
}

pub fn mul_div_floor(a: u128, b: u128, denominator: u128) -> u128 {
    assert!(denominator > 0, "ZERO_DENOMINATOR");
    amount(U256::from(a) * U256::from(b) / U256::from(denominator))
}

pub fn mul_div_ceil(a: u128, b: u128, denominator: u128) -> u128 {
    assert!(denominator > 0, "ZERO_DENOMINATOR");
    let product = U256::from(a) * U256::from(b);
    let denominator = U256::from(denominator);
    amount(product / denominator + U256::from(u8::from(product % denominator != U256::ZERO)))
}

pub fn interest(principal: u128, apr_bps: u16, seconds: u64, remainder: u64) -> (u128, u64) {
    let numerator =
        U256::from(principal) * U256::from(apr_bps) * U256::from(seconds) + U256::from(remainder);
    let denominator = U256::from(INTEREST_DENOMINATOR);
    (
        amount(numerator / denominator),
        (numerator % denominator)
            .try_into()
            .expect("REMAINDER_OVERFLOW"),
    )
}
