#[test_only]
module kanso::collateral_vault_tests;
use kanso::collateral_vault::{Self, Vault};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self, Scenario};

fun setup(): Scenario {
    let mut scenario = test_scenario::begin(@0xB);
    collateral_vault::create(@0xD, @0xA, @0xC, scenario.ctx());
    clock::create_for_testing(scenario.ctx()).share_for_testing();
    scenario.next_tx(@0xB);
    let mut vault = scenario.take_shared<Vault>();
    let collateral = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    collateral_vault::deposit(&mut vault, @0x1, @0x2, @0xB, @0x3, @0xB, 0, collateral, scenario.ctx());
    test_scenario::return_shared(vault);
    scenario.next_tx(@0xC);
    scenario
}
fun finish(scenario: Scenario, vault: Vault, clock: Clock) {test_scenario::return_shared(vault);test_scenario::return_shared(clock);scenario.end();}

#[test]
fun partial_sale_and_release_keep_real_coin_accounting() {
    let mut scenario = setup();let mut vault = scenario.take_shared<Vault>();let clock = scenario.take_shared<Clock>();
    collateral_vault::execute(&mut vault, &clock, @0x11, @0x1, @0x2, @0x55, @0x5, 300, 0, 600, 1, scenario.ctx());
    assert!(collateral_vault::remaining(&vault,@0x1)==700);
    assert!(collateral_vault::accounted_balance(&vault)==700);
    collateral_vault::execute(&mut vault, &clock, @0x12, @0x1, @0x2, @0x0, @0xB, 700, 1, 600, 0, scenario.ctx());
    assert!(collateral_vault::remaining(&vault,@0x1)==0);
    assert!(collateral_vault::is_executed(&vault,@0x12));
    test_scenario::return_shared(vault);test_scenario::return_shared(clock);
    scenario.next_tx(@0xB);let received = scenario.take_from_sender<Coin<SUI>>();assert!(received.value()==700);coin::burn_for_testing(received);
    scenario.next_tx(@0x5);let sold=scenario.take_from_sender<Coin<SUI>>();assert!(sold.value()==300);coin::burn_for_testing(sold);scenario.end();
}

#[test]
#[expected_failure(abort_code=4, location=kanso::collateral_vault)]
fun depositor_cannot_release() {
    let mut scenario=setup();scenario.next_tx(@0xB);let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x0,@0xB,1000,0,600,0,scenario.ctx());finish(scenario,vault,clock);
}
#[test]
#[expected_failure(abort_code=3, location=kanso::collateral_vault)]
fun duplicate_operation_cannot_spend_twice() {
    let mut scenario=setup();let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x0,@0xB,100,0,600,0,scenario.ctx());
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x0,@0xB,100,1,600,0,scenario.ctx());finish(scenario,vault,clock);
}
#[test]
#[expected_failure(abort_code=6, location=kanso::collateral_vault)]
fun invalidation_kills_old_authorization() {
    let mut scenario=setup();let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x0,@0x0,0,0,600,2,scenario.ctx());
    assert!(collateral_vault::remaining(&vault,@0x1)==1000);
    collateral_vault::execute(&mut vault,&clock,@0x12,@0x1,@0x2,@0x0,@0xB,1000,0,600,0,scenario.ctx());finish(scenario,vault,clock);
}
#[test]
#[expected_failure(abort_code=7, location=kanso::collateral_vault)]
fun source_clock_rejects_expired_commands() {
    let mut scenario=setup();let mut vault=scenario.take_shared<Vault>();let mut clock=scenario.take_shared<Clock>();clock.set_for_testing(601_000);
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x0,@0xB,100,0,600,0,scenario.ctx());finish(scenario,vault,clock);
}
#[test]
#[expected_failure(abort_code=5, location=kanso::collateral_vault)]
fun wrong_agreement_rejected() {
    let mut scenario=setup();let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x99,@0x0,@0xB,100,0,600,0,scenario.ctx());finish(scenario,vault,clock);
}
#[test]
#[expected_failure(abort_code=8, location=kanso::collateral_vault)]
fun rent_and_other_locks_are_not_spendable() {
    let mut scenario=setup();let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x0,@0xB,1001,0,600,0,scenario.ctx());finish(scenario,vault,clock);
}
#[test]
#[expected_failure(abort_code=3, location=kanso::collateral_vault)]
fun duplicate_deposit_cannot_replace_owner_or_balance() {
    let mut scenario=setup();let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();let collateral=coin::mint_for_testing<SUI>(9000,scenario.ctx());
    collateral_vault::deposit(&mut vault,@0x1,@0x2,@0xC,@0x3,@0xC,0,collateral,scenario.ctx());finish(scenario,vault,clock);
}

#[test]
fun event_bytes_match_the_coordinator_decoder() {
    let mut scenario = test_scenario::begin(@0xC);
    collateral_vault::create(@0xD,@0xA,@0xC,scenario.ctx());clock::create_for_testing(scenario.ctx()).share_for_testing();
    scenario.next_tx(@0xC);let mut vault=scenario.take_shared<Vault>();let clock=scenario.take_shared<Clock>();
    let collateral=coin::mint_for_testing<SUI>(1000,scenario.ctx());collateral_vault::deposit(&mut vault,@0x1,@0x2,@0xB,@0x3,@0xB,0,collateral,scenario.ctx());
    collateral_vault::execute(&mut vault,&clock,@0x11,@0x1,@0x2,@0x55,@0x5,300,0,600,1,scenario.ctx());
    let deposits=sui::event::events_by_type<collateral_vault::LockAccepted>();
    let commands=sui::event::events_by_type<collateral_vault::CommandExecuted>();
    let deposit=std::bcs::to_bytes(&deposits[0]);let command=std::bcs::to_bytes(&commands[0]);
    assert!(deposit.length()==297);assert!(command.length()==281);
    assert!(deposit[288]==0);assert!(deposit[289]==232 && deposit[290]==3);
    assert!(command[256]==44 && command[257]==1);assert!(command[264]==188 && command[265]==2);assert!(command[280]==1);
    finish(scenario,vault,clock);
}
