import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { APPROX_PHP_PER_USD, type CashInIntent, type IntentStatus, watchIntent } from '@/lib/onramp';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

/** ₱ with thousands separators + 2 decimals (Hermes has no full Intl). */
function formatPhp(n: number): string {
  const [whole, cents] = n.toFixed(2).split('.');
  return '₱' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + cents;
}

export default function AddCash() {
  const { addCash, refresh } = useWallet();
  const popup = usePopup();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  // Once an intent is open we switch to the "pay" step and poll its status.
  const [intent, setIntent] = useState<CashInIntent | null>(null);
  const [status, setStatus] = useState<IntentStatus>('pending');
  const stopWatch = useRef<(() => void) | null>(null);

  const value = parseFloat(amount) || 0;
  const approxPhp = value > 0 ? formatPhp(value * APPROX_PHP_PER_USD) : null;

  useEffect(() => () => stopWatch.current?.(), []);

  const onContinue = async () => {
    setBusy(true);
    try {
      const opened = await addCash(value);
      setIntent(opened);
      setStatus(opened.status);
      // Watch for delivery. On `delivered` we refresh the wallet so the new
      // balance shows; expired/failed surface an error state.
      stopWatch.current = watchIntent(opened.id, (s) => {
        setStatus(s);
        if (s === 'delivered') refresh();
      });
    } catch (e: any) {
      popup.alert({ title: 'Could not start deposit', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const onClose = () => {
    stopWatch.current?.();
    router.back();
  };

  // ── Step 2: pay the pesos, wait for delivery ──────────────────────────────
  if (intent) {
    const delivered = status === 'delivered';
    const dead = status === 'expired' || status === 'failed';
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>{delivered ? 'Deposited' : 'Send your payment'}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.ink} />
          </Pressable>
        </View>

        <View style={styles.payBody}>
          {delivered ? (
            <>
              <View style={styles.doneCircle}>
                <Ionicons name="checkmark" size={40} color="#fff" />
              </View>
              <Text style={styles.doneAmount}>{formatUsd(intent.amountUsdc)}</Text>
              <Text style={styles.balanceHint}>is now in your account.</Text>
            </>
          ) : dead ? (
            <>
              <View style={[styles.doneCircle, { backgroundColor: colors.sub }]}>
                <Ionicons name="close" size={40} color="#fff" />
              </View>
              <Text style={styles.doneAmount}>Deposit {status}</Text>
              <Text style={styles.balanceHint}>
                {status === 'expired'
                  ? "This request timed out. If you already paid, don't worry — contact support and we'll sort it."
                  : 'Something went wrong. If you already paid, contact support and we’ll sort it.'}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.payLabel}>Send exactly</Text>
              <Text style={styles.payAmount}>{formatPhp(intent.amountPhp)}</Text>
              <Text style={styles.payLabel}>
                via {intent.deposit.label}
                {intent.deposit.account ? `  ·  ${intent.deposit.account}` : ''}
              </Text>

              <View style={styles.matchCard}>
                <Ionicons name="information-circle-outline" size={18} color={colors.accentDark} />
                <Text style={styles.matchText}>
                  Send from your own GCash/bank account and pay the exact amount — that’s how we match your
                  payment to this deposit.
                </Text>
              </View>

              <View style={styles.waitRow}>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.balanceHint}>Waiting for your payment… your balance updates automatically.</Text>
              </View>
            </>
          )}
        </View>

        <View style={styles.bottom}>
          <Button title={delivered ? 'Done' : dead ? 'Close' : 'I’ve sent it'} onPress={onClose} />
          {!delivered && !dead && (
            <Text style={styles.finePrint}>You can close this — we’ll notify you when it lands.</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ── Step 1: pick an amount ────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Deposit</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.amountWrap}>
        <Text style={styles.amount}>${amount || '0'}</Text>
        {approxPhp && <Text style={styles.approx}>≈ {approxPhp}</Text>}
      </View>

      <View style={styles.bottom}>
        <View style={styles.methodRow}>
          <Ionicons name="phone-portrait-outline" size={18} color={colors.accentDark} />
          <Text style={styles.methodLabel}>Pay with GCash / bank via InstaPay</Text>
        </View>

        <AmountPad value={amount} onChange={setAmount} />
        <Button
          title={value > 0 ? `Deposit ${formatUsd(value)}` : 'Deposit'}
          onPress={onContinue}
          disabled={value <= 0}
          loading={busy}
          style={{ marginTop: 8 }}
        />
        <Text style={styles.finePrint}>You’ll pay in pesos; your balance is in dollars.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  amountWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottom: {},
  amount: { fontSize: 56, fontWeight: '800', color: colors.ink },
  approx: { fontSize: 18, fontWeight: '600', color: colors.sub, marginTop: 4 },
  balanceHint: { color: colors.sub, fontSize: 14, marginTop: 8, textAlign: 'center' },

  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  methodLabel: { fontSize: 14, fontWeight: '600', color: colors.ink },

  // Pay step
  payBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  payLabel: { fontSize: 15, fontWeight: '600', color: colors.sub, textAlign: 'center' },
  payAmount: { fontSize: 48, fontWeight: '800', color: colors.ink, marginVertical: 6 },
  matchCard: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 24,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  matchText: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.accentDark, lineHeight: 18 },
  waitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 28 },

  doneCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  doneAmount: { fontSize: 32, fontWeight: '800', color: colors.ink },

  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10 },
});
