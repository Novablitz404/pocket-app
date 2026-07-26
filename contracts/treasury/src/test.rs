#![cfg(test)]

//! Unit tests for the Treasury against a MINIMAL mock vault that mirrors just
//! the surface the Treasury calls (`balance_of`, `value_of`, `withdraw`). The
//! real earn-vault + Blend wiring is exercised by the live testnet
//! integration test, not here — these prove the Treasury's OWN logic:
//! self-authorized fee realization, USDC sweeping, and admin gating.

use crate::{Treasury, TreasuryClient};
use soroban_sdk::{contract, contractimpl, contracttype, testutils::Address as _, token, Address, Env};

#[contract]
pub struct MockVault;

#[contracttype]
enum MockVaultKey {
    Usdc,
    Shares(Address),
}

#[contractimpl]
impl MockVault {
    pub fn init(e: Env, usdc: Address) {
        e.storage().instance().set(&MockVaultKey::Usdc, &usdc);
    }

    /// Test helper: seed a holder's share balance (as if fees had accrued).
    pub fn set_shares(e: Env, who: Address, amount: i128) {
        e.storage().persistent().set(&MockVaultKey::Shares(who), &amount);
    }

    pub fn balance_of(e: Env, user: Address) -> i128 {
        e.storage().persistent().get(&MockVaultKey::Shares(user)).unwrap_or(0)
    }

    /// 1:1 share->value for simplicity (the real vault's virtual-offset math
    /// is covered in the vault crate's own tests).
    pub fn value_of(e: Env, user: Address) -> i128 {
        Self::balance_of(e, user)
    }

    /// Burns `shares` from `user` and pays out 1:1 USDC from the mock's own
    /// balance — mirrors the real vault paying `to = user` from the pool.
    pub fn withdraw(e: Env, user: Address, shares: i128) -> i128 {
        user.require_auth();
        let bal: i128 = e.storage().persistent().get(&MockVaultKey::Shares(user.clone())).unwrap_or(0);
        if shares > bal {
            panic!("insufficient shares");
        }
        e.storage().persistent().set(&MockVaultKey::Shares(user.clone()), &(bal - shares));
        let usdc: Address = e.storage().instance().get(&MockVaultKey::Usdc).unwrap();
        let this = e.current_contract_address();
        token::Client::new(&e, &usdc).transfer(&this, &user, &shares);
        shares
    }
}

struct Harness {
    env: Env,
    usdc: token::Client<'static>,
    treasury: TreasuryClient<'static>,
    treasury_addr: Address,
    admin: Address,
}

fn setup(seed_fee_shares: i128) -> Harness {
    let env = Env::default();
    // The Treasury self-authorizes calling vault.withdraw(this, ..) at a
    // non-root position, same shape as the vault<->Blend case.
    env.mock_all_auths_allowing_non_root_auth();

    let usdc_admin = Address::generate(&env);
    let usdc_sac = env.register_stellar_asset_contract_v2(usdc_admin.clone()).address();
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc_sac);
    let usdc = token::Client::new(&env, &usdc_sac);

    let vault_id = env.register(MockVault, ());
    let vault_client = MockVaultClient::new(&env, &vault_id);
    vault_client.init(&usdc_sac);

    let admin = Address::generate(&env);
    let treasury_id = env.register(Treasury, ());
    let treasury = TreasuryClient::new(&env, &treasury_id);
    treasury.initialize(&admin, &vault_id, &usdc_sac);

    // Seed fees: give the Treasury `seed_fee_shares` vault shares, and fund
    // the mock vault with matching USDC so withdrawals are backed.
    if seed_fee_shares > 0 {
        vault_client.set_shares(&treasury_id, &seed_fee_shares);
        usdc_admin_client.mint(&vault_id, &seed_fee_shares);
    }

    Harness { env, usdc, treasury, treasury_addr: treasury_id, admin }
}

#[test]
fn claim_fees_realizes_shares_to_usdc() {
    let h = setup(100_0000000); // 100 USDC of accrued fees
    let paid = h.treasury.claim_fees(&40_0000000);
    assert_eq!(paid, 40_0000000);
    assert_eq!(h.treasury.usdc_balance(), 40_0000000);
    assert_eq!(h.treasury.fee_shares(), 60_0000000);
    assert_eq!(h.usdc.balance(&h.treasury_addr), 40_0000000);
}

#[test]
fn claim_all_fees_realizes_everything() {
    let h = setup(100_0000000);
    let paid = h.treasury.claim_all_fees();
    assert_eq!(paid, 100_0000000);
    assert_eq!(h.treasury.fee_shares(), 0);
    assert_eq!(h.treasury.usdc_balance(), 100_0000000);
}

#[test]
fn claim_all_with_no_fees_is_a_noop() {
    let h = setup(0);
    assert_eq!(h.treasury.claim_all_fees(), 0);
    assert_eq!(h.treasury.usdc_balance(), 0);
}

#[test]
fn sweep_moves_usdc_out() {
    let h = setup(100_0000000);
    h.treasury.claim_all_fees();
    let dest = Address::generate(&h.env);
    h.treasury.sweep(&dest, &30_0000000);
    assert_eq!(h.usdc.balance(&dest), 30_0000000);
    assert_eq!(h.treasury.usdc_balance(), 70_0000000);
}

#[test]
#[should_panic]
fn sweep_more_than_held_panics() {
    let h = setup(10_0000000);
    h.treasury.claim_all_fees(); // 10 USDC realized
    let dest = Address::generate(&h.env);
    h.treasury.sweep(&dest, &20_0000000); // over-sweep
}

#[test]
#[should_panic]
fn claim_requires_admin() {
    let h = setup(100_0000000);
    h.env.set_auths(&[]); // strip mocked auths
    h.treasury.claim_fees(&1_0000000);
}

#[test]
#[should_panic]
fn sweep_requires_admin() {
    let h = setup(100_0000000);
    h.treasury.claim_all_fees();
    let dest = Address::generate(&h.env);
    h.env.set_auths(&[]);
    h.treasury.sweep(&dest, &1_0000000);
}

#[test]
fn two_step_admin_transfer() {
    let h = setup(100_0000000);
    let new_admin = Address::generate(&h.env);
    h.treasury.propose_admin(&new_admin);
    h.treasury.accept_admin();
    // New admin can now act; the call authorizes fine under mocked auths.
    h.treasury.claim_all_fees();
    let _ = h.admin;
}

#[test]
fn views_report_accrued_position() {
    let h = setup(75_0000000);
    assert_eq!(h.treasury.fee_shares(), 75_0000000);
    assert_eq!(h.treasury.fee_value(), 75_0000000);
    assert_eq!(h.treasury.usdc_balance(), 0);
}
