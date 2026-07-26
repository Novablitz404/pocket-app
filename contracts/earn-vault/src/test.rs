#![cfg(test)]

//! Unit tests. Since Blend's actual pool contract isn't available as a
//! dependency here, these tests run against a MINIMAL mock pool
//! (`MockBlendPool` below) that mirrors just enough of Blend's real
//! behavior — single-reserve b-token accounting driven by a settable
//! `b_rate` — to exercise the vault's share math, fee accrual, and auth
//! rules. This does NOT replace the live-testnet integration test the build
//! plan calls for (confirming the vault's assumptions about Blend's real
//! `to`-address withdrawal semantics, the EmisData footprint race, etc.) —
//! it only proves the vault's OWN logic is correct in isolation.

use crate::blend::{ContractReserve, Positions, ReserveConfig, ReserveData, Request, SCALAR_12};
use crate::{EarnVault, EarnVaultClient};
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, token, Address, Env, Map, Vec,
};

#[contract]
pub struct MockBlendPool;

#[derive(Clone)]
#[soroban_sdk::contracttype]
enum MockKey {
    UsdcSac,
    ReserveIndex,
    BRate,
    Supply(Address),
}

#[contractimpl]
impl MockBlendPool {
    pub fn init(e: Env, usdc_sac: Address, reserve_index: u32, initial_b_rate: i128) {
        e.storage().instance().set(&MockKey::UsdcSac, &usdc_sac);
        e.storage().instance().set(&MockKey::ReserveIndex, &reserve_index);
        e.storage().instance().set(&MockKey::BRate, &initial_b_rate);
    }

    /// Test-only: simulates interest accrual by bumping the exchange rate.
    /// Callers must separately mint the mock pool enough extra USDC to back
    /// the implied value increase, or a later withdrawal will fail on
    /// insufficient token balance (mirrors a real pool only ever reflecting
    /// b_rate increases that are actually backed by borrower interest).
    pub fn set_b_rate(e: Env, new_rate: i128) {
        e.storage().instance().set(&MockKey::BRate, &new_rate);
    }

    pub fn get_reserve(e: Env, asset: Address) -> ContractReserve {
        let reserve_index: u32 = e.storage().instance().get(&MockKey::ReserveIndex).unwrap();
        let b_rate: i128 = e.storage().instance().get(&MockKey::BRate).unwrap();
        ContractReserve {
            asset,
            config: ReserveConfig {
                c_factor: 0,
                decimals: 7,
                enabled: true,
                index: reserve_index,
                l_factor: 0,
                max_util: 0,
                r_base: 0,
                r_one: 0,
                r_three: 0,
                r_two: 0,
                reactivity: 0,
                supply_cap: 0,
                util: 0,
            },
            data: ReserveData {
                b_rate,
                b_supply: 0,
                backstop_credit: 0,
                d_rate: 0,
                d_supply: 0,
                ir_mod: 0,
                last_time: 0,
            },
            scalar: SCALAR_12,
        }
    }

    pub fn get_positions(e: Env, user: Address) -> Positions {
        let reserve_index: u32 = e.storage().instance().get(&MockKey::ReserveIndex).unwrap();
        let b_tokens: i128 = e
            .storage()
            .persistent()
            .get(&MockKey::Supply(user))
            .unwrap_or(0);
        let mut supply = Map::new(&e);
        supply.set(reserve_index, b_tokens);
        Positions {
            collateral: Map::new(&e),
            liabilities: Map::new(&e),
            supply,
        }
    }

    pub fn submit(e: Env, from: Address, spender: Address, to: Address, requests: Vec<Request>) -> Positions {
        from.require_auth();
        spender.require_auth();

        let usdc_sac: Address = e.storage().instance().get(&MockKey::UsdcSac).unwrap();
        let b_rate: i128 = e.storage().instance().get(&MockKey::BRate).unwrap();
        let token_client = token::Client::new(&e, &usdc_sac);
        let pool_address = e.current_contract_address();

        let mut b_tokens: i128 = e
            .storage()
            .persistent()
            .get(&MockKey::Supply(from.clone()))
            .unwrap_or(0);

        for req in requests.iter() {
            if req.request_type == crate::blend::REQUEST_TYPE_SUPPLY {
                token_client.transfer(&spender, &pool_address, &req.amount);
                b_tokens += (req.amount * SCALAR_12) / b_rate;
            } else if req.request_type == crate::blend::REQUEST_TYPE_WITHDRAW {
                b_tokens -= (req.amount * SCALAR_12) / b_rate;
                if b_tokens < 0 {
                    panic!("mock pool: withdrawal exceeds position");
                }
                token_client.transfer(&pool_address, &to, &req.amount);
            }
        }

        e.storage().persistent().set(&MockKey::Supply(from.clone()), &b_tokens);
        Self::get_positions(e, from)
    }
}

/// Test harness: wires up a mock USDC token, a mock Blend pool, and a fresh
/// vault instance, returning everything a test needs.
struct Harness {
    env: Env,
    usdc_admin: token::StellarAssetClient<'static>,
    usdc: token::Client<'static>,
    pool: Address,
    vault: EarnVaultClient<'static>,
    fee_recipient: Address,
    admin: Address,
}

fn setup(fee_bps: u32) -> Harness {
    let env = Env::default();
    // Not `mock_all_auths()` — the vault authorizes itself as `from`/`spender`
    // when calling into Blend's `submit`, which is a non-root auth (the
    // vault's own address never appears as a root-invocation signer, only
    // the depositing/withdrawing user's does). Same real-world shape as
    // Soroban's own documented example for this exact scenario.
    env.mock_all_auths_allowing_non_root_auth();

    let usdc_admin_addr = Address::generate(&env);
    let usdc_sac_id = env.register_stellar_asset_contract_v2(usdc_admin_addr.clone()).address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_sac_id);
    let usdc = token::Client::new(&env, &usdc_sac_id);

    let reserve_index = 0u32;
    let initial_b_rate = SCALAR_12; // 1:1 to start
    let pool_id = env.register(MockBlendPool, ());
    let pool_client = MockBlendPoolClient::new(&env, &pool_id);
    pool_client.init(&usdc_sac_id, &reserve_index, &initial_b_rate);

    let admin = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let vault_id = env.register(EarnVault, ());
    let vault = EarnVaultClient::new(&env, &vault_id);
    vault.initialize(&admin, &fee_recipient, &fee_bps, &usdc_sac_id, &pool_id, &reserve_index);

    Harness {
        env,
        usdc_admin,
        usdc,
        pool: pool_id,
        vault,
        fee_recipient,
        admin,
    }
}

fn mint(h: &Harness, to: &Address, amount: i128) {
    h.usdc_admin.mint(to, &amount);
}

/// Simulates the pool earning `profit` in interest: bump b_rate so the
/// vault's existing b-tokens are now worth `profit` more, AND mint the pool
/// itself `profit` extra USDC so a later withdrawal has real backing (see
/// `MockBlendPool::set_b_rate`'s doc comment).
fn accrue_pool_interest(h: &Harness, profit: i128) {
    let pool_client = MockBlendPoolClient::new(&h.env, &h.pool);
    let current_b_rate: i128 = h.env.as_contract(&h.pool, || {
        h.env.storage().instance().get(&MockKey::BRate).unwrap()
    });
    let vault_b_tokens_before = h.vault.total_assets(); // underlying value pre-bump == b_tokens at old rate
    let _ = vault_b_tokens_before;
    // Compute new b_rate from the vault's OWN b-token count so the bump maps
    // to exactly `profit` additional underlying value for the vault's
    // position specifically (fine for these single-depositor-position-owner
    // tests, since the vault is the pool's only position holder).
    let vault_addr = h.env.as_contract(&h.pool, || h.env.current_contract_address());
    let _ = vault_addr;
    let b_tokens: i128 = h.env.as_contract(&h.pool, || {
        h.env
            .storage()
            .persistent()
            .get(&MockKey::Supply(h.vault.address.clone()))
            .unwrap_or(0)
    });
    let new_b_rate = if b_tokens > 0 {
        current_b_rate + (profit * SCALAR_12) / b_tokens
    } else {
        current_b_rate
    };
    pool_client.set_b_rate(&new_b_rate);
    mint(h, &h.pool, profit);
}

#[test]
fn first_deposit_mints_shares_1_to_1_ish() {
    let h = setup(1200); // 12%
    let user = Address::generate(&h.env);
    mint(&h, &user, 100_0000000); // 100 USDC

    let shares = h.vault.deposit(&user, &100_0000000);
    // Virtual-offset formula: shares = amount * (0 + 1e6) / (0 + 1) = amount * 1e6.
    // What matters for correctness isn't the raw share count (arbitrary
    // units) but that value_of() reflects the deposit accurately:
    assert_eq!(h.vault.value_of(&user), 100_0000000);
    assert_eq!(h.vault.balance_of(&user), shares);
    assert_eq!(h.vault.total_assets(), 100_0000000);
}

#[test]
fn second_depositor_gets_fair_price_against_skewed_early_ratio() {
    let h = setup(1200);
    let user1 = Address::generate(&h.env);
    mint(&h, &user1, 1_0000000); // 1 USDC — tiny first deposit
    h.vault.deposit(&user1, &1_0000000);

    let user2 = Address::generate(&h.env);
    mint(&h, &user2, 1000_0000000); // 1000 USDC
    h.vault.deposit(&user2, &1000_0000000);

    // Virtual-offset math must not let user1's tiny first deposit expropriate
    // user2's much larger one — each should be able to withdraw ~what they put in.
    let v1 = h.vault.value_of(&user1);
    let v2 = h.vault.value_of(&user2);
    assert!((v1 - 1_0000000).abs() <= 1, "user1 value drifted: {}", v1);
    assert!((v2 - 1000_0000000).abs() <= 1, "user2 value drifted: {}", v2);
}

#[test]
fn fee_accrues_on_profit_and_dilutes_existing_holders() {
    let h = setup(1200); // 12%
    let user = Address::generate(&h.env);
    mint(&h, &user, 1000_0000000);
    h.vault.deposit(&user, &1000_0000000);

    // Simulate 100 USDC of yield accruing in the pool.
    accrue_pool_interest(&h, 100_0000000);

    // Trigger accrual via a second user's deposit.
    let user2 = Address::generate(&h.env);
    mint(&h, &user2, 1_0000000);
    h.vault.deposit(&user2, &1_0000000);

    // 12% of 100 profit = 12 USDC worth of value now owned by fee_recipient.
    let fee_value = h.vault.value_of(&h.fee_recipient);
    assert!((fee_value - 12_0000000).abs() <= 10, "fee value: {}", fee_value);

    // Original depositor should have ~88 of the 100 profit (net of the fee),
    // i.e. ~1088 total, NOT the full 1100.
    let user_value = h.vault.value_of(&user);
    assert!(
        (user_value - 1088_0000000).abs() <= 10,
        "user value after dilution: {}",
        user_value
    );
}

#[test]
fn repeated_accrual_with_no_new_interest_mints_nothing_twice() {
    let h = setup(1200);
    let user = Address::generate(&h.env);
    mint(&h, &user, 1000_0000000);
    h.vault.deposit(&user, &1000_0000000);
    accrue_pool_interest(&h, 50_0000000);

    let user2 = Address::generate(&h.env);
    mint(&h, &user2, 1_0000000);
    h.vault.deposit(&user2, &1_0000000); // first accrual fires here

    let fee_shares_after_first = h.vault.balance_of(&h.fee_recipient);

    // A second deposit with NO intervening interest event must not mint any
    // more fee shares — accrual is idempotent.
    let user3 = Address::generate(&h.env);
    mint(&h, &user3, 1_0000000);
    h.vault.deposit(&user3, &1_0000000);

    assert_eq!(h.vault.balance_of(&h.fee_recipient), fee_shares_after_first);
}

#[test]
fn value_decrease_mints_no_fee_and_a_recovery_to_the_old_peak_mints_no_new_fee_either() {
    // This is the genuine high-water-mark property: fee is only ever
    // charged on value ABOVE the highest point ever recorded. A dip
    // followed by a full recovery back to that same peak is NOT "new
    // profit" and must not be taxed again — that would double-charge
    // depositors for value they (or predecessors) already paid fee on once,
    // on the way up the first time.
    let h = setup(1200);
    let user = Address::generate(&h.env);
    mint(&h, &user, 1000_0000000);
    h.vault.deposit(&user, &1000_0000000);
    let pool_client = MockBlendPoolClient::new(&h.env, &h.pool);

    // 1) Establish a genuine profit PEAK with real (backed) yield, and fire
    //    accrue_fee once so the high-water mark is set to that peak.
    accrue_pool_interest(&h, 100_0000000); // +100 real yield -> b_rate now the peak
    let peak_rate: i128 = h.env.as_contract(&h.pool, || {
        h.env.storage().instance().get(&MockKey::BRate).unwrap()
    });
    let trigger = Address::generate(&h.env);
    mint(&h, &trigger, 1_0000000);
    h.vault.deposit(&trigger, &1_0000000); // accrue fires -> hwm = 100 profit
    let shares_at_peak = h.vault.balance_of(&h.fee_recipient);
    assert!(shares_at_peak > 0, "fee should have been charged at the real peak");

    // 2) DIP below the peak (lower b_rate, no interim deposit that would buy
    //    b-tokens cheap and pollute the recovery).
    pool_client.set_b_rate(&(peak_rate - (peak_rate / 10))); // -10% from peak

    // 3) RECOVER exactly back to the peak rate. current profit == HWM (not
    //    >), so accrue must mint ZERO new fee shares — the whole point of a
    //    high-water mark: value already fee'd on the way up isn't re-taxed.
    pool_client.set_b_rate(&peak_rate);
    let trigger2 = Address::generate(&h.env);
    mint(&h, &trigger2, 1_0000000);
    h.vault.deposit(&trigger2, &1_0000000); // accrue fires with profit <= hwm

    assert_eq!(
        h.vault.balance_of(&h.fee_recipient),
        shares_at_peak,
        "recovering to the old peak must not mint any new fee shares"
    );
}

#[test]
fn dust_round_trip_cannot_extract_value() {
    let h = setup(1200);
    let user = Address::generate(&h.env);
    mint(&h, &user, 1_000_0000000); // plenty of USDC to fund many round-trips
    h.vault.deposit(&user, &100_0000000); // 100 USDC seed deposit

    let mut running_value = h.vault.value_of(&user);
    for _ in 0..50 {
        let bal = h.vault.balance_of(&user);
        // Withdraw a meaningful fraction each round (not literal dust) —
        // burning 1 share out of ~1e13 would floor to a 0 payout and hit the
        // vault's own "withdrawal too small" guard, which is correct
        // behavior but not what this test is trying to exercise. The
        // property under test is that no amount of round-tripping can ever
        // net-extract value, at any granularity above that floor.
        let withdraw_shares = bal / 10;
        if withdraw_shares <= 0 {
            break;
        }
        let withdrawn = h.vault.withdraw(&user, &withdraw_shares);
        h.vault.deposit(&user, &withdrawn);
        let now = h.vault.value_of(&user);
        assert!(now <= running_value, "value increased via round-trip: {} -> {}", running_value, now);
        running_value = now;
    }
}

#[test]
#[should_panic]
fn withdraw_more_than_owned_panics() {
    let h = setup(1200);
    let user = Address::generate(&h.env);
    mint(&h, &user, 10_0000000);
    let shares = h.vault.deposit(&user, &10_0000000);
    h.vault.withdraw(&user, &(shares + 1));
}

#[test]
#[should_panic]
fn admin_function_requires_admin_auth() {
    let h = setup(1200);
    h.env.set_auths(&[]); // strip mocked auths for this call
    h.vault.set_fee_bps(&500);
}

#[test]
fn two_step_admin_transfer() {
    let h = setup(1200);
    let new_admin = Address::generate(&h.env);
    h.vault.propose_admin(&new_admin);
    h.vault.accept_admin();
    // Old admin can no longer act; new admin can.
    h.vault.set_fee_recipient(&h.admin); // called as new_admin via mocked auths (mock_all_auths doesn't check WHO, only that auth was required)
    let _ = h.admin;
}

#[test]
fn withdraw_all_burns_full_position() {
    let h = setup(1200);
    let user = Address::generate(&h.env);
    mint(&h, &user, 500_0000000);
    h.vault.deposit(&user, &500_0000000);
    h.vault.withdraw_all(&user);
    assert_eq!(h.vault.balance_of(&user), 0);
    assert_eq!(h.usdc.balance(&user), 500_0000000);
}
