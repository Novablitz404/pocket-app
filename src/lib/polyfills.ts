// Must be imported before anything that touches @stellar/stellar-sdk.
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import 'event-target-polyfill'; // Event + EventTarget for Hermes
import { Buffer } from 'buffer';

const g = globalThis as any;
if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}

// Hermes has AbortController but not the static AbortSignal.timeout().
if (typeof g.AbortSignal !== 'undefined' && typeof g.AbortSignal.timeout !== 'function') {
  g.AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('TimeoutError')), ms);
    return controller.signal;
  };
}

// The SDK's EventSource subclasses these DOM event types at module load.
if (typeof g.MessageEvent === 'undefined') {
  g.MessageEvent = class MessageEvent extends g.Event {
    data: unknown;
    lastEventId: string;
    origin: string;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.data = init.data ?? null;
      this.lastEventId = init.lastEventId ?? '';
      this.origin = init.origin ?? '';
    }
  };
}
if (typeof g.CustomEvent === 'undefined') {
  g.CustomEvent = class CustomEvent extends g.Event {
    detail: unknown;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
  };
}

// Hermes fix: @stellar/stellar-sdk's Asset.fromOperation decodes the asset
// code via `assetCode().toString()`. On Node that byte array is a Buffer and
// decodes to e.g. "USDC"; on Hermes it's a Uint8Array whose toString() yields
// "85,83,68,67" (comma-joined bytes), which fails the alphanumeric check and
// throws "asset code is invalid". This breaks any Asset rebuilt from XDR —
// notably buildFeeBumpTransaction re-parsing an inner payment. Re-implement
// fromOperation with an explicit ASCII decode. Loaded here (require, after the
// Buffer global is set) so the patch is in place before any SDK use.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
{
  const { Asset, StrKey, xdr } = sdk;
  const decodeCode = (raw: any): string => {
    let s = Buffer.from(raw).toString('ascii');
    while (s.endsWith('\0')) s = s.slice(0, -1);
    return s;
  };
  console.log('[polyfills] Asset.fromOperation patched (Hermes decode fix)');
  (Asset as any).fromOperation = function fromOperationHermesSafe(assetXdr: any) {
    switch (assetXdr.switch()) {
      case xdr.AssetType.assetTypeNative():
        return Asset.native();
      case xdr.AssetType.assetTypeCreditAlphanum4(): {
        const anum = assetXdr.alphaNum4();
        const issuer = StrKey.encodeEd25519PublicKey(anum.issuer().ed25519());
        return new Asset(decodeCode(anum.assetCode()), issuer);
      }
      case xdr.AssetType.assetTypeCreditAlphanum12(): {
        const anum = assetXdr.alphaNum12();
        const issuer = StrKey.encodeEd25519PublicKey(anum.issuer().ed25519());
        return new Asset(decodeCode(anum.assetCode()), issuer);
      }
      default:
        throw new Error(`Invalid asset type: ${assetXdr.switch().name}`);
    }
  };
}
