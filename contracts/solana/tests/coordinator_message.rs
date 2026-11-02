use borsh::{to_vec, BorshDeserialize};
use kanso_solana_vault::state::{Config, Lock};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_program::{pubkey::Pubkey, rent::Rent};
use solana_transaction::Transaction;
fn bytes(value: &serde_json::Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect()
}
fn array(value: &serde_json::Value) -> [u8; 32] {
    bytes(value).try_into().unwrap()
}
#[test]
fn coordinator_constructed_and_signed_message_executes_in_the_sbf_vm() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../../test/fixtures/solana-execution.json")).unwrap();
    let program = Pubkey::new_from_array(array(&v["program"]));
    let config = Pubkey::new_from_array(array(&v["config"]));
    let controller = Pubkey::new_from_array(array(&v["controller"]));
    let recipient = Pubkey::new_from_array(array(&v["recipient"]));
    let lock_id = array(&v["lock_id"]);
    let (lock_address, _) =
        Pubkey::find_program_address(&[b"lock", config.as_ref(), &lock_id], &program);
    let amount: u64 = v["amount"].as_str().unwrap().parse().unwrap();
    let mut svm = LiteSVM::new().with_blockhash_check(false);
    svm.add_program_from_file(
        program,
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/deploy/kanso_solana_vault.so"),
    )
    .unwrap();
    svm.airdrop(&controller, 1_000_000_000).unwrap();
    svm.airdrop(&recipient, 1_000_000).unwrap();
    let configuration = Config {
        tag: Config::TAG,
        deployment: array(&v["deployment"]),
        network: [9; 32],
        controller: controller.to_bytes(),
    };
    let lock = Lock {
        tag: Lock::TAG,
        config: config.to_bytes(),
        lock_id,
        agreement: array(&v["agreement"]),
        borrower: array(&v["borrower"]),
        leg_id: array(&v["leg_id"]),
        owner: array(&v["owner"]),
        refund_recipient: recipient.to_bytes(),
        purpose: 0,
        deposited: amount,
        remaining: amount,
        nonce: 0,
    };
    for (address, data, principal) in [
        (config, to_vec(&configuration).unwrap(), 0),
        (lock_address, to_vec(&lock).unwrap(), amount),
    ] {
        svm.set_account(
            address,
            Account {
                lamports: Rent::default().minimum_balance(data.len()) + principal,
                data,
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    }
    let tx: Transaction = bincode::deserialize(&bytes(&v["signed_transaction"])).unwrap();
    tx.verify().unwrap();
    let recipient_before = svm.get_balance(&recipient).unwrap();
    svm.send_transaction(tx).unwrap();
    let released: u64 = v["released"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        svm.get_balance(&recipient).unwrap(),
        recipient_before + released
    );
    let after = Lock::try_from_slice(&svm.get_account(&lock_address).unwrap().data).unwrap();
    assert_eq!(after.remaining, amount - released);
    assert_eq!(after.nonce, 1);
}
