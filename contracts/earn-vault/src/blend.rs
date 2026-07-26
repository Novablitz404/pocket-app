//! Mirror types + helper calls for Blend Capital's pool contract.
//!
//! No Rust crate for Blend's pool contract exists as a dependency here, so
//! these types are hand-mirrored to match Blend's actual on-chain XDR shape
//! exactly (field NAMES are what matter for `#[contracttype]`'s Map-based
//! encoding — `soroban_sdk`'s derive macro sorts fields alphabetically for
//! the wire format regardless of declaration order, unlike the app's
//! TypeScript client which has to alphabetize map keys by hand). Verified
//! against the vendored `@blend-capital/blend-sdk` package's own type
//! definitions (`pool_contract.d.ts`, `reserve_types.d.ts`, `user_types.d.ts`)
//! during planning — NOT yet confirmed against a live on-chain call. The
//! integration test (see plan) must confirm these shapes decode correctly
//! against Blend's real testnet pool before this is trusted with real value.

use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{contracttype, Address, Env, IntoVal, Map, Symbol, Val, Vec};

pub const REQUEST_TYPE_SUPPLY: u32 = 0;
pub const REQUEST_TYPE_WITHDRAW: u32 = 1;

/// Mirrors Blend's `Request` struct. Only ever constructed here to send to
/// Blend (never decoded), so field types just need to encode compatibly.
#[contracttype]
#[derive(Clone)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

/// Mirrors Blend's `Positions` struct (per-user, or here, the vault's own
/// aggregate position). b-token/d-token amounts keyed by reserve index.
#[contracttype]
#[derive(Clone)]
pub struct Positions {
    pub collateral: Map<u32, i128>,
    pub liabilities: Map<u32, i128>,
    pub supply: Map<u32, i128>,
}

/// Mirrors Blend's `ReserveConfigV2`. The vault only actually reads `index`,
/// but the full shape is mirrored to avoid any ambiguity in cross-contract
/// decoding (a partial-field mismatch would only surface at call time).
#[contracttype]
#[derive(Clone)]
pub struct ReserveConfig {
    pub c_factor: u32,
    pub decimals: u32,
    pub enabled: bool,
    pub index: u32,
    pub l_factor: u32,
    pub max_util: u32,
    pub r_base: u32,
    pub r_one: u32,
    pub r_three: u32,
    pub r_two: u32,
    pub reactivity: u32,
    pub supply_cap: i128,
    pub util: u32,
}

/// Mirrors Blend's `ReserveData`. The vault only actually reads `b_rate`.
#[contracttype]
#[derive(Clone)]
pub struct ReserveData {
    pub b_rate: i128,
    pub b_supply: i128,
    pub backstop_credit: i128,
    pub d_rate: i128,
    pub d_supply: i128,
    pub ir_mod: i128,
    pub last_time: u64,
}

/// Mirrors Blend's `ContractReserve`, the return type of `get_reserve`.
#[contracttype]
#[derive(Clone)]
pub struct ContractReserve {
    pub asset: Address,
    pub config: ReserveConfig,
    pub data: ReserveData,
    pub scalar: i128,
}

/// Blend v2 fixed-point scalar for `b_rate` (12 decimals) — same constant
/// `earn-blend.ts`'s `SCALAR_12` uses.
pub const SCALAR_12: i128 = 1_000_000_000_000;

/// Calls Blend's `get_reserve(asset)`, returning the reserve's config+data.
pub fn get_reserve(e: &Env, pool: &Address, asset: &Address) -> ContractReserve {
    let args: Vec<soroban_sdk::Val> = soroban_sdk::vec![e, asset.into_val(e)];
    e.invoke_contract(pool, &Symbol::new(e, "get_reserve"), args)
}

/// Calls Blend's `get_positions(user)` for the given position-holder address
/// (here, always the vault's own contract address).
pub fn get_positions(e: &Env, pool: &Address, user: &Address) -> Positions {
    let args: Vec<soroban_sdk::Val> = soroban_sdk::vec![e, user.into_val(e)];
    e.invoke_contract(pool, &Symbol::new(e, "get_positions"), args)
}

/// Calls Blend's `submit(from, spender, to, requests)` with a single
/// request. Returns the caller's (`from`'s) updated `Positions`.
pub fn submit_one(
    e: &Env,
    pool: &Address,
    from: &Address,
    spender: &Address,
    to: &Address,
    reserve_asset: &Address,
    request_type: u32,
    amount: i128,
) -> Positions {
    let request = Request {
        address: reserve_asset.clone(),
        amount,
        request_type,
    };
    let requests = soroban_sdk::vec![e, request];
    let args: Vec<Val> = soroban_sdk::vec![
        e,
        from.into_val(e),
        spender.into_val(e),
        to.into_val(e),
        requests.into_val(e),
    ];

    // On a SUPPLY, Blend's `submit` pulls `amount` from the vault (spender)
    // into the pool via the SAC's `transfer(from=vault, to=pool, amount)`.
    // That transfer is invoked BY THE POOL on the vault's behalf — a call
    // deeper in the stack than the vault's own `submit` invocation — so the
    // vault must pre-authorize it here. (The vault's direct `submit` call, and
    // the `from`/`spender` `require_auth` Blend runs inside it, are
    // auto-authorized because the vault is submit's direct invoker — per the
    // soroban-sdk `authorize_as_current_contract` docs, only the DEEPER call
    // needs an explicit top-level entry, NOT a wrapping `submit` context.)
    // On a WITHDRAW the pool pays `to` out of its OWN balance, so nothing is
    // pulled from the vault and no authorization is needed.
    if request_type == REQUEST_TYPE_SUPPLY {
        let transfer_args: Vec<Val> = soroban_sdk::vec![
            e,
            spender.into_val(e),
            pool.into_val(e),
            amount.into_val(e),
        ];
        e.authorize_as_current_contract(soroban_sdk::vec![
            e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: reserve_asset.clone(),
                    fn_name: Symbol::new(e, "transfer"),
                    args: transfer_args,
                },
                sub_invocations: soroban_sdk::vec![e],
            })
        ]);
    }

    e.invoke_contract(pool, &Symbol::new(e, "submit"), args)
}

/// b-tokens -> underlying-asset value, floor-divided — same conversion
/// `earn-blend.ts`'s `suppliedFromSnapshot` already does client-side.
pub fn b_tokens_to_assets(b_tokens: i128, b_rate: i128) -> i128 {
    (b_tokens * b_rate) / SCALAR_12
}
