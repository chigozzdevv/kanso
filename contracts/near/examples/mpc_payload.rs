use near_mpc_contract_interface::types::ForeignTxSignPayload;
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("READ_PAYLOAD");
    let payload: ForeignTxSignPayload = serde_json::from_str(&input).expect("INVALID_PAYLOAD");
    let hash = payload
        .compute_msg_hash()
        .expect("INVALID_PAYLOAD_ENCODING");
    println!("{}", hex::encode(hash.0));
}
