mod common;
use common::*;
use kanso_coordinator::math;

fn next(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    *seed
}
#[test]
fn interest_is_independent_of_checkpoint_partitioning_across_1024_cases() {
    let mut seed = 0x4b414e534f;
    for _ in 0..1024 {
        let principal = u128::from(next(&mut seed));
        let apr = (next(&mut seed) % 10_001) as u16;
        let mut remaining = next(&mut seed) % 63_072_001;
        let expected = math::interest(principal, apr, remaining, 0);
        let (mut total, mut remainder) = (0, 0);
        while remaining > 0 {
            let elapsed = (next(&mut seed) % (remaining + 1)).max(1);
            let result = math::interest(principal, apr, elapsed, remainder);
            total += result.0;
            remainder = result.1;
            remaining -= elapsed;
        }
        assert_eq!((total, remainder), expected);
    }
}
#[test]
fn varying_partial_payments_and_replays_preserve_cash_debt_and_nav() {
    let mut f = Fixture::new();
    f.funded("loan");
    let mut seed = 0x4b414e534f;
    let mut expected_cash = 900_000_000;
    let mut expected_debt = 100_000_000;
    for index in 0..64 {
        let amount = u128::from(next(&mut seed) % 10_000_000 + 1);
        let id = format!("payment_{index}");
        let unused = f.repay("loan", &id, amount, NOW).0;
        let used = amount.min(expected_debt);
        assert_eq!(unused, amount - used);
        expected_debt -= used;
        expected_cash += used;
        let loan = f.contract.get_loan("loan".into());
        let revision = loan.revision;
        assert_eq!(loan.debt(), expected_debt);
        assert_eq!(
            f.contract.get_pool("pool".into()).cash_atomic.0,
            expected_cash
        );
        assert_eq!(expected_cash + expected_debt, 1_000_000_000);
        assert_eq!(f.contract.pool_nav("pool".into()).0, 1_000_000_000);
        assert_eq!(f.repay("loan", &id, amount, NOW).0, amount);
        assert_eq!(f.contract.get_loan("loan".into()).revision, revision);
        f.contract.finalize_transfer("fund_loan".into());
        assert_eq!(
            f.contract.get_pool("pool".into()).cash_atomic.0,
            expected_cash
        );
    }
    assert_eq!(expected_debt, 0);
}
