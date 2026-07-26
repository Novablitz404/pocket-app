import { getEarnState, getSupplied } from '../src/lib/earn-vault.ts';

const address = process.argv[2] ?? 'GBWIRENBNLKFPLJFJF3ETMUMAEEZWEDGMP6J4UFDC6YRTEZHO4KMUK2Q';
const netDeposited = parseFloat(process.argv[3] ?? '39.95');

const state = await getEarnState(address);
console.log('supplied:', state.supplied);
console.log('apy:', (state.apy * 100).toFixed(2) + '%');
console.log('netDeposited:', netDeposited);
console.log('earned = supplied - netDeposited =', state.supplied - netDeposited);
console.log('perDay at this APY:', (state.supplied * state.apy) / 365);
