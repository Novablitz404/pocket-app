# 2-of-3 + KMS custody — test coverage

This is the record of how the 2-of-3 multisig + Google KMS custody design was
verified on testnet. For the design itself, see
[security-custody.md](./security-custody.md).

> The test scripts themselves are kept in the local working tree
> (`packages/app/scripts/custody-2of3/`) and are **not committed** — they carry
> testnet keys/paths and hit the live deployed functions. This document is the
> durable record of what each one proves.

## What was verified

| Test | Type | What it proves |
|------|------|----------------|
| close-semantics | offline testnet | Stellar validates signatures against the **transaction-start snapshot**, so a 2-of-3 close can remove its own signers mid-tx and still authorize the `accountMerge`. |
| send-cosign | offline testnet | The 2-of-3 send path: user (w1) alone is rejected (`tx_bad_auth`); user + Remitt co-sign (w2) inside a fee-bump succeeds. |
| migrate | offline testnet | Old-shape (treasury weight-2) → 2-of-3 migration, for both **normal** and **recovered** account shapes: treasury-alone converts them, then user/device + Remitt sends work and user-alone fails. |
| e2e-live | **live** (deployed fns) | End-to-end against the deployed Supabase functions: `reserve-channel` + `activate-account` create a real on-chain 2-of-3, verified signers/thresholds, then a user-signed payment reaches w2 via the **production KMS co-signature** and settles. |
| feebump-negative | **live** | Security guardrail: the deployed `fee-bump` **refuses to co-sign** anything that isn't a legit USDC send (non-USDC payment, `setOptions` re-key, `accountMerge`, `changeTrust`, wrong op-source, soroban-mismatch, treasury source) — at the validation layer, before KMS signs. 7/7 negative cases refused. |
| close-live | **live** | The deployed `close-account` (treasury + compliance + Remitt-KMS quorum) merges a 2-of-3 account away: **zero-balance** close, and **with-balance** close that sweeps the USDC to the treasury first (verified by the treasury balance delta) then merges. |
| freeze-live | **live** | The freeze control: freezing via the admin `set-freeze` makes the deployed `fee-bump` refuse to co-sign the account's sends (`account is frozen`), no on-chain change; unfreezing restores them. Admin gate rejects a wrong secret (401). |
| recovery-chain | offline testnet | Recovery-CHAIN correctness: across `master → device1 → device2 → device3`, each recovery revokes **every** prior user key (master *and* prior device signers), so only the newest key ever works. |
| pin-lockout | **live** | Recovery-PIN brute-force lockout (`verify_recovery_pin` via `close-account`): 5 wrong PINs lock the address for 15 min, and while locked even the correct PIN is refused. |
| channel-concurrency | **live** | N concurrent activations each get a **distinct** channel account from the `reserve-channel` pool — no shared sequence numbers, zero `tx_bad_seq` collisions. |
| audit-wallets | **live** (read-only) | Classifies every wallet in the `profiles` table by on-chain shape: unactivated / old (treasury co-signer) / 2-of-3 (robust to recovered accounts). |

## Result

All core custody flows are verified in production (testnet): **create, send,
recover (incl. multi-recovery chains), Earn, close, freeze**, plus the fee-bump
security guardrails, the PIN lockout, and channel-pool concurrency. Send,
recovery, and Earn were additionally confirmed live in-app.

One real bug was found and fixed during this pass: `recover-account` previously
revoked only the master key, leaving earlier device keys valid across a chain of
recoveries — now it revokes every prior user-controlled signer.
