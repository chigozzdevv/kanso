use crate::{events, Coordinator, CoordinatorExt};
use near_sdk::{env, near, serde_json::json};
#[near(serializers=[borsh,json])]
#[derive(Clone, Default)]
#[serde(deny_unknown_fields)]
pub struct PauseFlags {
    pub origination: bool,
    pub collateral_withdrawals: bool,
    pub settlements: bool,
}
#[near]
impl Coordinator {
    #[payable]
    pub fn set_pause_flags(&mut self, flags: PauseFlags) {
        Self::one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.config.owner,
            "OWNER_REQUIRED"
        );
        self.controls_revision += 1;
        self.controls = flags;
        events::emit(
            &self.config.deployment_id,
            "ControlsUpdated",
            &self.config.deployment_id,
            self.controls_revision,
            json!({"flags":self.controls}),
        );
    }
    pub fn get_pause_flags(&self) -> PauseFlags {
        self.controls.clone()
    }
}
