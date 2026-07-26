// Single source of truth for which Stellar network every Edge Function talks
// to. Driven by the STELLAR_NETWORK secret (testnet|mainnet, defaults to
// testnet) rather than each function hardcoding Horizon URL / passphrase /
// USDC issuer / Blend pool ID independently — that's what caused them to
// drift out of sync in the first place. Flip STELLAR_NETWORK and redeploy;
// nothing else needs to change per-function.
//
// Mirrors packages/app/scripts/switch-network.mjs's NETWORKS table (the
// client-side equivalent) — keep the two in sync if either changes.
const NETWORKS = {
  testnet: {
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    BLEND_POOL_ID: 'CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW',
    // Pocket Earn vault — the only contract fee-bump will co-sign Soroban
    // invokes of (see assertSorobanIsVaultInvoke). Keep in sync with
    // scripts/switch-network.mjs's VAULT_ID.
    VAULT_ID: 'CBP5D6AW6RX3G55TNJGASQCQ66WHRR3VCHMHQ4Y2WX4AZVKZFMK7PUQ3',
  },
  mainnet: {
    HORIZON_URL: 'https://horizon.stellar.org',
    NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    USDC_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // Circle's official mainnet USDC issuer
    BLEND_POOL_ID: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
    VAULT_ID: '', // deployed in Stage 3; until then no Soroban invoke is co-signed on mainnet
  },
} as const;

const network = Deno.env.get('STELLAR_NETWORK') === 'mainnet' ? 'mainnet' : 'testnet';
export const { HORIZON_URL, NETWORK_PASSPHRASE, USDC_ISSUER, BLEND_POOL_ID, VAULT_ID } = NETWORKS[network];
export const USDC_CODE = 'USDC';
export const IS_MAINNET = network === 'mainnet';

// Same reasoning as the client's SOROBAN_RPC split in earn-blend.ts: two
// separate secrets (not one) so testnet keeps working while a mainnet
// project exists side by side, picked by the same STELLAR_NETWORK flag.
export const SOROBAN_RPC =
  Deno.env.get(IS_MAINNET ? 'SOROBAN_RPC_URL_MAINNET' : 'SOROBAN_RPC_URL_TESTNET') ??
  (IS_MAINNET ? 'https://soroban-rpc.stellar.org' : 'https://soroban-testnet.stellar.org');
