import * as s from '../src/lib/stellar.ts';

const address = process.argv[2] ?? 'GBWIRENBNLKFPLJFJF3ETMUMAEEZWEDGMP6J4UFDC6YRTEZHO4KMUK2Q';
const acts = await s.getActivity(address);
const earnActs = acts.filter((a) => a.kind === 'earn-deposit' || a.kind === 'earn-withdraw');
for (const a of earnActs.reverse()) {
  console.log(a.createdAt, a.kind, a.amount);
}
