#![no_std]

//! Pocket Earn vault — pools users' USDC into ONE aggregate Blend Capital
//! lending-pool position and charges 12% of yield via dilutive fee-share
//! minting (the Yearn-V2 / ERC-4626 "performance fee" pattern), instead of
//! today's flat 0.5%-of-withdrawal fee. See the Stage 1 build plan
//! (`blend-vault-treasury-sponsor-build-plan` memory note) for the full
//! design rationale — short version: a flat withdrawal fee only realizes
//! revenue when a given user happens to withdraw; dilutive fee-shares make
//! Pocket's cut accrue continuously as a side effect of ANY user's
//! deposit/withdraw activity, with no separate scheduled harvest needed.
//!
//! No raw Blend passthrough entrypoint is exposed on purpose — the only
//! paths into Blend are the two hardcoded calls inside `deposit`/`withdraw`.
//!
//! Deliberately does NOT cache a "total vault value" figure for share
//! pricing — Blend's own state is always live-queryable
//! (`current_assets`/`total_assets`), so share math always uses a fresh
//! read. Fees are measured against two exact bookkeeping figures instead:
//! `NetDeposits` (net contributed capital) and `HighWaterMark` (the peak
//! RETAINED PROFIT, i.e. peak `current_assets - NetDeposits`). Measuring
//! profit relative to net principal — rather than against a cached absolute
//! asset level — is what makes deposits/withdrawals invisible to the fee: a
//! deposit raises assets and `NetDeposits` by the same amount, so it never
//! reads as yield. Only real Blend interest moves `current_assets -
//! NetDeposits`, and only the part of that above the high-water mark is fee'd.

mod blend;
#[cfg(test)]
mod test;

use blend::{b_tokens_to_assets, get_positions, get_reserve, submit_one, REQUEST_TYPE_SUPPLY, REQUEST_TYPE_WITHDRAW};
use soroban_sdk::{contract, contractimpl, contracttype, token, Address, BytesN, Env};

/// Virtual shares/assets offset (OpenZeppelin's ERC-4626 inflation-attack
/// fix) baked into every share-price calculation — NOT a special-cased
/// first-deposit path. `decimals_offset = 6` (10^6 virtual shares, 1 virtual
/// asset unit) means an attacker would need to eat a >10^6:1 loss ratio to
/// make a first-depositor price-manipulation attack profitable.
const VIRTUAL_SHARES: i128 = 1_000_000;
const VIRTUAL_ASSETS: i128 = 1;

/// Fee rate is out of this denominator (1200 = 12.00%).
const BPS_DENOM: i128 = 10_000;
const MAX_FEE_BPS: u32 = 3_000; // sanity cap, 30%

/// Scale for `share_price()`'s returned fixed-point value (7 decimals,
/// matching USDC stroops — shares themselves carry the same 7-decimal scale
/// as underlying USDC amounts, see the build plan's "Precision" section).
const PRICE_SCALAR: i128 = 10_000_000;

#[contracttype]
pub enum DataKey {
    Admin,
    PendingAdmin,
    FeeRecipient,
    FeeBps,
    UsdcSac,
    BlendPool,
    ReserveIndex,
    TotalShares,
    /// Net principal contributed: `sum(deposits) - sum(withdrawal payouts)`.
    /// This is the fee cost-basis — profit is `current_assets - NetDeposits`,
    /// so deposits/withdrawals (which move assets and this figure in
    /// lockstep) never register as profit. Only genuine Blend yield does.
    NetDeposits,
    /// Fee-detection only — the highest PROFIT (`assets - NetDeposits`) ever
    /// observed. Only ever moves up; never reset down on a loss (see
    /// `accrue_fee`), so a dip-then-recovery isn't taxed twice.
    HighWaterMark,
    Shares(Address),
}

#[contract]
pub struct EarnVault;

#[contractimpl]
impl EarnVault {
    pub fn initialize(
        e: Env,
        admin: Address,
        fee_recipient: Address,
        fee_bps: u32,
        usdc_sac: Address,
        blend_pool: Address,
        reserve_index: u32,
    ) {
        if e.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if fee_bps > MAX_FEE_BPS {
            panic!("fee_bps exceeds cap");
        }
        admin.require_auth();

        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::FeeRecipient, &fee_recipient);
        e.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        e.storage().instance().set(&DataKey::UsdcSac, &usdc_sac);
        e.storage().instance().set(&DataKey::BlendPool, &blend_pool);
        e.storage().instance().set(&DataKey::ReserveIndex, &reserve_index);
        e.storage().instance().set(&DataKey::TotalShares, &0i128);
        e.storage().instance().set(&DataKey::NetDeposits, &0i128);
        e.storage().instance().set(&DataKey::HighWaterMark, &0i128);
    }

    /// Deposits `amount` USDC (7-decimal stroops) on behalf of `user`.
    /// Returns the number of vault shares minted.
    pub fn deposit(e: Env, user: Address, amount: i128) -> i128 {
        user.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }

        // The vault's real value BEFORE this deposit's own principal lands —
        // shares are priced against this, so fresh principal is never taxed,
        // and any pending profit is diluted into existing holders first.
        let assets_before = Self::accrue_fee(&e);

        let usdc_sac: Address = e.storage().instance().get(&DataKey::UsdcSac).unwrap();
        let vault = e.current_contract_address();
        token::Client::new(&e, &usdc_sac).transfer(&user, &vault, &amount);

        let total_shares: i128 = e.storage().instance().get(&DataKey::TotalShares).unwrap();
        let shares_minted = (amount * (total_shares + VIRTUAL_SHARES)) / (assets_before + VIRTUAL_ASSETS);
        if shares_minted <= 0 {
            panic!("deposit too small to mint a share");
        }

        let blend_pool: Address = e.storage().instance().get(&DataKey::BlendPool).unwrap();
        submit_one(&e, &blend_pool, &vault, &vault, &vault, &usdc_sac, REQUEST_TYPE_SUPPLY, amount);

        let user_shares: i128 = e
            .storage()
            .persistent()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0);
        e.storage()
            .persistent()
            .set(&DataKey::Shares(user.clone()), &(user_shares + shares_minted));
        e.storage().instance().set(&DataKey::TotalShares, &(total_shares + shares_minted));

        // Fresh principal raises the fee cost-basis by exactly what came in,
        // so it is never later mistaken for yield.
        let net_deposits: i128 = e.storage().instance().get(&DataKey::NetDeposits).unwrap_or(0);
        e.storage().instance().set(&DataKey::NetDeposits, &(net_deposits + amount));

        shares_minted
    }

    /// Burns `shares` of `user`'s vault position, paying out the underlying
    /// USDC directly to `user` (Blend's `to` field pays the recipient
    /// straight from the pool, no extra transfer hop needed). Returns the
    /// underlying amount paid out.
    pub fn withdraw(e: Env, user: Address, shares: i128) -> i128 {
        user.require_auth();
        if shares <= 0 {
            panic!("shares must be positive");
        }

        let assets_before = Self::accrue_fee(&e);

        let user_shares: i128 = e
            .storage()
            .persistent()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0);
        if shares > user_shares {
            panic!("insufficient shares");
        }

        let total_shares: i128 = e.storage().instance().get(&DataKey::TotalShares).unwrap();
        let payout = (shares * (assets_before + VIRTUAL_ASSETS)) / (total_shares + VIRTUAL_SHARES);
        if payout <= 0 {
            panic!("withdrawal too small to pay out");
        }

        let usdc_sac: Address = e.storage().instance().get(&DataKey::UsdcSac).unwrap();
        let blend_pool: Address = e.storage().instance().get(&DataKey::BlendPool).unwrap();
        let vault = e.current_contract_address();
        submit_one(&e, &blend_pool, &vault, &vault, &user, &usdc_sac, REQUEST_TYPE_WITHDRAW, payout);

        e.storage()
            .persistent()
            .set(&DataKey::Shares(user.clone()), &(user_shares - shares));
        e.storage().instance().set(&DataKey::TotalShares, &(total_shares - shares));

        // Paying out lowers the cost-basis in lockstep with assets, so the
        // retained profit-above-basis (and thus the HWM) is untouched. This
        // may go negative once realized profit is paid out — that is correct
        // and self-consistent: it stays exactly offset against the HWM, so
        // `current_assets - NetDeposits` keeps measuring true retained profit.
        let net_deposits: i128 = e.storage().instance().get(&DataKey::NetDeposits).unwrap_or(0);
        e.storage().instance().set(&DataKey::NetDeposits, &(net_deposits - payout));

        payout
    }

    /// Withdraws 100% of `user`'s shares (accrues fee first, so the user is
    /// credited for any profit up to and including this call).
    pub fn withdraw_all(e: Env, user: Address) -> i128 {
        Self::accrue_fee(&e);
        let shares: i128 = e
            .storage()
            .persistent()
            .get(&DataKey::Shares(user.clone()))
            .unwrap_or(0);
        Self::withdraw(e, user, shares)
    }

    // ---- Views ----
    // All three read LIVE state (a fresh cross-contract query into Blend),
    // not a cached figure — see the module doc comment on why no "total
    // value" cache exists at all in this design.

    pub fn balance_of(e: Env, user: Address) -> i128 {
        e.storage().persistent().get(&DataKey::Shares(user)).unwrap_or(0)
    }

    pub fn total_assets(e: Env) -> i128 {
        Self::current_assets(&e)
    }

    pub fn share_price(e: Env) -> i128 {
        let total_shares: i128 = e.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        let assets = Self::current_assets(&e);
        (assets + VIRTUAL_ASSETS) * PRICE_SCALAR / (total_shares + VIRTUAL_SHARES)
    }

    pub fn value_of(e: Env, user: Address) -> i128 {
        let shares: i128 = e.storage().persistent().get(&DataKey::Shares(user)).unwrap_or(0);
        let total_shares: i128 = e.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
        let assets = Self::current_assets(&e);
        (shares * (assets + VIRTUAL_ASSETS)) / (total_shares + VIRTUAL_SHARES)
    }

    // ---- Admin (two-step transfer, mirrors Blend's own admin pattern) ----

    pub fn propose_admin(e: Env, new_admin: Address) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
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

    pub fn set_fee_bps(e: Env, new_bps: u32) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if new_bps > MAX_FEE_BPS {
            panic!("fee_bps exceeds cap");
        }
        e.storage().instance().set(&DataKey::FeeBps, &new_bps);
    }

    pub fn set_fee_recipient(e: Env, new_recipient: Address) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        e.storage().instance().set(&DataKey::FeeRecipient, &new_recipient);
    }

    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        e.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ---- Internal ----

    /// Live value of the vault's own aggregate Blend position, in
    /// underlying USDC (7-decimal stroops). Two read-only cross-contract
    /// calls (`get_reserve`, `get_positions`) — no state mutation.
    fn current_assets(e: &Env) -> i128 {
        let blend_pool: Address = e.storage().instance().get(&DataKey::BlendPool).unwrap();
        let usdc_sac: Address = e.storage().instance().get(&DataKey::UsdcSac).unwrap();
        let reserve_index: u32 = e.storage().instance().get(&DataKey::ReserveIndex).unwrap();
        let vault = e.current_contract_address();

        let reserve = get_reserve(e, &blend_pool, &usdc_sac);
        let positions = get_positions(e, &blend_pool, &vault);

        // The vault only ever SUPPLYs (never posts as loan collateral), but
        // fall back to the collateral map too for parity with how
        // earn-blend.ts reads a plain user's position, in case Blend ever
        // moves a supply position into the collateral map internally.
        let b_tokens = positions.supply.get(reserve_index).unwrap_or(0)
            + positions.collateral.get(reserve_index).unwrap_or(0);

        b_tokens_to_assets(b_tokens, reserve.data.b_rate)
    }

    /// Runs at the START of every deposit/withdraw. Mints new shares to the
    /// fee recipient equal to `fee_bps` of any profit above the all-time
    /// high-water mark, diluting all existing shareholders' share price in
    /// the same instant — this is what makes the fee "continuous" rather
    /// than tied to any one user's own withdrawal. Idempotent: calling this
    /// twice with no intervening Blend interest event mints exactly zero the
    /// second time. Returns the live `current_assets` value it computed, so
    /// callers don't need a second cross-contract round trip.
    fn accrue_fee(e: &Env) -> i128 {
        let current = Self::current_assets(e);
        let net_deposits: i128 = e.storage().instance().get(&DataKey::NetDeposits).unwrap_or(0);
        // Retained profit = live assets minus net contributed capital. Because
        // deposits/withdrawals move `current` and `net_deposits` together,
        // only genuine Blend yield changes this figure.
        let retained_profit = current - net_deposits;
        let hwm: i128 = e.storage().instance().get(&DataKey::HighWaterMark).unwrap_or(0);

        if retained_profit > hwm {
            let new_profit = retained_profit - hwm;
            let fee_bps: i128 = e.storage().instance().get::<DataKey, u32>(&DataKey::FeeBps).unwrap() as i128;
            let fee_assets = (new_profit * fee_bps) / BPS_DENOM;

            if fee_assets > 0 {
                let total_shares: i128 = e.storage().instance().get(&DataKey::TotalShares).unwrap_or(0);
                let denom = current - fee_assets;
                if denom > 0 && total_shares > 0 {
                    // Mint against POST-fee-deduction assets, so the fee
                    // recipient's new shares are priced at the post-dilution
                    // share price, not the pre-dilution one — minting
                    // against pre-fee assets under-mints the fee, the
                    // subtle bit naive ports of this pattern get wrong.
                    let fee_shares = (fee_assets * total_shares) / denom;
                    if fee_shares > 0 {
                        let fee_recipient: Address = e.storage().instance().get(&DataKey::FeeRecipient).unwrap();
                        let recipient_shares: i128 = e
                            .storage()
                            .persistent()
                            .get(&DataKey::Shares(fee_recipient.clone()))
                            .unwrap_or(0);
                        e.storage().persistent().set(
                            &DataKey::Shares(fee_recipient.clone()),
                            &(recipient_shares + fee_shares),
                        );
                        e.storage()
                            .instance()
                            .set(&DataKey::TotalShares, &(total_shares + fee_shares));
                    }
                }
            }

            // Advance the peak to the new retained-profit level. Only reached
            // when retained_profit > hwm, so it only ever moves up — never
            // reset down on a loss. A later recovery back toward the old peak
            // is therefore not re-taxed as "new profit."
            e.storage().instance().set(&DataKey::HighWaterMark, &retained_profit);
        }

        current
    }
}
