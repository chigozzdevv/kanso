use near_sdk::{
    env,
    serde_json::{json, Value},
};

pub fn emit(deployment_id: &str, event: &str, object_id: &str, revision: u64, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "kanso",
            "version": "1.0.0",
            "event": event,
            "data": [{
                "event_id": format!("{deployment_id}:{object_id}:{event}:{revision}"),
                "deployment_id": deployment_id,
                "object_id": object_id,
                "revision": revision.to_string(),
                "record": data,
            }],
        })
    ));
}
