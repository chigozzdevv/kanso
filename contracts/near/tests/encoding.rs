use kanso_coordinator::{encoding::encode_offer, state::Offer};
use near_sdk::{env, test_utils::VMContextBuilder, testing_env};

#[test]
fn offer_commitment_matches_typescript_fixture() {
    testing_env!(VMContextBuilder::new().build());
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../test/fixtures/offer-v2.json")).unwrap();
    let offer: Offer = serde_json::from_value(fixture["offer"].clone()).unwrap();
    let bytes = encode_offer(&offer);
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let hash = env::sha256(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    assert_eq!(hex, fixture["encoded_hex"].as_str().unwrap());
    assert_eq!(hash, fixture["sha256"].as_str().unwrap());
}
