// Wraps a fully-signed inner transaction in a treasury-paid FEE-BUMP. The inner
// tx's source account (a channel account, for the custodial ops) still supplies
// its own sequence number; only the FEE moves to the treasury. Net effect:
// channel accounts become PURE sequence-number providers — they need only their
// one-time base reserve to exist and never drain from fees, so there are no
// ongoing channel top-ups. This makes the treasury the single, universal gas
// payer across every flow (P2P/cash-out/Earn already fee-bump; now activate/
// recover/close do too), which is the mainnet-aligned model.
//
// Fee-bumping does NOT change the inner tx hash, so all inner signatures
// (channel source, treasury-as-sponsor, compliance, KMS) stay valid; the
// treasury adds one more signature over the fee-bump envelope. Mirrors the XDR
// construction fee-bump/index.ts already uses for user txs.
import { Buffer } from "node:buffer";
import { Keypair, type Transaction, hash, xdr } from "npm:@stellar/stellar-sdk@^16";

// Stroops per (op + 1) — generous headroom over the 100-stroop network base
// fee, matching fee-bump/index.ts. The treasury pays this.
const FEE_BUMP_FEE_PER_UNIT = 2000n;

export function feeBumpEnvelope(
  inner: Transaction,
  feeSource: Keypair,
  networkPassphrase: string,
): string {
  const totalFee = (
    FEE_BUMP_FEE_PER_UNIT * BigInt(inner.operations.length + 1)
  ).toString();

  const feeBumpTx = new xdr.FeeBumpTransaction({
    feeSource: feeSource.xdrMuxedAccount(),
    fee: xdr.Int64.fromString(totalFee),
    innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(inner.toEnvelope().v1()),
    ext: new xdr.FeeBumpTransactionExt(0),
  });

  const sigPayload = new xdr.TransactionSignaturePayload({
    networkId: hash(Buffer.from(networkPassphrase)),
    taggedTransaction:
      xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(
        feeBumpTx,
      ),
  });
  const decorated = feeSource.signDecorated(hash(sigPayload.toXDR()));

  const envelope = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({ tx: feeBumpTx, signatures: [decorated] }),
  );
  return Buffer.from(envelope.toXDR()).toString("base64");
}
