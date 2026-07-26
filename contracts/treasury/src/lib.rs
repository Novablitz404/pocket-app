#![no_std]

//! Pocket Treasury — the destination for platform fee revenue.
//!
//! In the Stage 1 Earn design the vault charges 12% of yield by minting
//! dilutive fee-shares to its configured `fee_recipient`. This contract IS
//! that recipient: the fee-shares accrue to THIS contract's address inside
//! the vault automatically, as a side effect of any user's deposit/withdraw
//! activity — no scheduled harvest. Because the shares are owned by a
//! contract address (not a human key), only this contract's own admin-gated
//! logic can convert them to USDC and move them out — that is the whole
//! reason the fee recipient is a contract rather than a plain G-account.
//!
//! v1 SCOPE — accumulator only (decided 2026-07-25): receive + custody fee
//! revenue, let the admin realize accrued fee-shares into USDC and sweep
//! USDC out. Funding the Sponsor G-account (fees are USDC, Sponsor needs
//! XLM — a swap or a separately-topped-up XLM reserve) is deliberately NOT
//! in this version; see the `blend-vault-treasury-sponsor-build-plan` memory
//! note.

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    /// The Earn vault this Treasury collects fees from (its `fee_recipient`).
    Vault,
    /// USDC Stellar Asset Contract — the asset fee revenue is denominated in.
    UsdcSac,
}

#[contract]
pub struct Treasury;

#[contractimpl]
impl Treasury {
    pub fn initialize(e: Env, admin: Address, vault: Address, usdc_sac: Address) {
        if e.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Vault, &vault);
        e.storage().instance().set(&DataKey::UsdcSac, &usdc_sac);
    }

    /// Realize `shares` of accrued vault fee-shares into USDC held by THIS
    /// contract. Calls `vault.withdraw(this, shares)`; the vault pays the
    /// underlying USDC directly to `to = this`. The vault's own
    /// `this.require_auth()` is auto-satisfied because this contract is the
    /// direct invoker of `withdraw` (self-authorization). Returns USDC paid.
    pub fn claim_fees(e: Env, shares: i128) -> i128 {
        Self::require_admin(&e);
        if shares <= 0 {
            panic!("shares must be positive");
        }
        Self::vault_withdraw(&e, shares)
    }

    /// Realize the FULL accrued fee-share balance into USDC. Reads this
    /// contract's live vault share balance, then withdraws all of it.
    pub fn claim_all_fees(e: Env) -> i128 {
        Self::require_admin(&e);
        let shares = Self::fee_shares(e.clone());
        if shares <= 0 {
            return 0;
        }
        Self::vault_withdraw(&e, shares)
    }

    /// Move `amount` USDC out of the Treasury to `to` (e.g. Pocket's ops
    /// wallet). A direct SAC `transfer(from=this, to, amount)` — this
    /// contract's own auth is auto-satisfied as the direct invoker.
    pub fn sweep(e: Env, to: Address, amount: i128) {
        Self::require_admin(&e);
        if amount <= 0 {
            panic!("amount must be positive");
        }
        let usdc: Address = e.storage().instance().get(&DataKey::UsdcSac).unwrap();
        let this = e.current_contract_address();
        token::Client::new(&e, &usdc).transfer(&this, &to, &amount);
    }

    // ---- Views ----

    /// This contract's unrealized fee position, in vault shares.
    pub fn fee_shares(e: Env) -> i128 {
        let vault: Address = e.storage().instance().get(&DataKey::Vault).unwrap();
        let this = e.current_contract_address();
        let args: Vec<Val> = soroban_sdk::vec![&e, this.into_val(&e)];
        e.invoke_contract(&vault, &Symbol::new(&e, "balance_of"), args)
    }

    /// This contract's unrealized fee position, valued in underlying USDC.
    pub fn fee_value(e: Env) -> i128 {
        let vault: Address = e.storage().instance().get(&DataKey::Vault).unwrap();
        let this = e.current_contract_address();
        let args: Vec<Val> = soroban_sdk::vec![&e, this.into_val(&e)];
        e.invoke_contract(&vault, &Symbol::new(&e, "value_of"), args)
    }

    /// Realized USDC currently sitting in the Treasury (already claimed,
    /// not yet swept out).
    pub fn usdc_balance(e: Env) -> i128 {
        let usdc: Address = e.storage().instance().get(&DataKey::UsdcSac).unwrap();
        let this = e.current_contract_address();
        token::Client::new(&e, &usdc).balance(&this)
    }

    pub fn admin(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn vault(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Vault).unwrap()
    }

    // ---- Admin (two-step transfer, mirrors the vault's own pattern) ----

    pub fn propose_admin(e: Env, new_admin: Address) {
        Self::require_admin(&e);
        e.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
    }

    pub fn accept_admin(e: Env) {
        let pending: Address = e
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic!("no pending admin"));
        pending.require_auth();
        e.storage().instance().set(&DataKey::Admin, &pending);
        e.storage().instance().remove(&DataKey::PendingAdmin);
    }

    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        Self::require_admin(&e);
        e.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ---- Internal ----

    fn require_admin(e: &Env) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    /// Invokes `vault.withdraw(this, shares)`. On withdraw the vault has Blend
    /// pay `to = this` out of the pool's own balance — nothing is pulled FROM
    /// the Treasury — so no `authorize_as_current_contract` sub-tree is
    /// needed here (unlike a supply). Returns the USDC amount paid out.
    fn vault_withdraw(e: &Env, shares: i128) -> i128 {
        let vault: Address = e.storage().instance().get(&DataKey::Vault).unwrap();
        let this = e.current_contract_address();
        let args: Vec<Val> = soroban_sdk::vec![e, this.into_val(e), shares.into_val(e)];
        e.invoke_contract(&vault, &Symbol::new(e, "withdraw"), args)
    }
}

#[cfg(test)]
mod test;
