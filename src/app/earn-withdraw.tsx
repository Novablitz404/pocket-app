import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { Button } from '@/components/button';
import { MethodSheet } from '@/components/method-sheet';
import { usePopup } from '@/components/popup';
import { ensureUnlocked } from '@/lib/biometrics';
import { WITHDRAW_FEE_RATE, getSupplied } from '@/lib/earn-blend';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

// Anything within a cent of the full balance withdraws everything: interest
// keeps accruing between the quote and the transaction, so an "exact" full
// amount would leave dust behind where withdrawAll over-requests and closes
// the position cleanly.
const FULL_EPSILON = 0.01;

// Floor on partial withdrawals. Withdrawing everything is exempt, so a
// sub-$10 balance can still be closed out rather than stranded.
const MIN_WITHDRAW = 10;

// Quick picks above the keypad as fractions of the savings balance; "All"
// fills the full balance.
const PRESETS = [0.25, 0.5, 0.75];

/** Withdraw any amount from savings back to the wallet, then optionally cash
 *  out to GCash / bank. Mirrors the Add Money screen: big amount on top,
 *  keypad at the bottom. */
export default function Withdraw() {
  const { publicKey, earnWithdraw } = useWallet();
  const popup = usePopup();
  const [supplied, setSupplied] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [transferSheetVisible, setTransferSheetVisible] = useState(false);

  const load = useCallback(async () => {
    if (!publicKey) return;
    try {
      setSupplied(await getSupplied(publicKey));
    } catch {
      setSupplied(0);
    }
  }, [publicKey]);

  useEffect(() => {
    load();
  }, [load]);

  const value = parseFloat(amount) || 0;
  const isFull = supplied !== null && value >= supplied - FULL_EPSILON;
  const gross = isFull && supplied !== null ? supplied : value;
  const overMax = supplied !== null && value > supplied + FULL_EPSILON;
  const underMin = value > 0 && value < MIN_WITHDRAW && !isFull;
  const valid = supplied !== null && value > 0 && !overMax && !underMin;

  const presetAmount = (pct: number) => (supplied !== null ? supplied * pct : 0);

  const onPreset = (preset: number | 'all') => {
    if (supplied === null || supplied <= 0) return;
    setAmount(preset === 'all' ? supplied.toFixed(2) : presetAmount(preset).toFixed(2));
  };

  const onWithdraw = async () => {
    if (!valid || supplied === null) return;
    if (!(await ensureUnlocked(`Withdraw ${formatUsd(gross)} from savings`))) return;
    setBusy(true);
    try {
      // Full withdrawals close the position (over-request + ledger reset);
      // partial ones move exactly what was asked.
      const result = await earnWithdraw(isFull ? undefined : value);
      const toBank = await popup.confirm({
        title: 'Withdrawn',
        message: `${formatUsd(result.withdrawn - result.fee)} is back in your wallet. Transfer to GCash / bank now?`,
        confirmText: 'Transfer',
      });
      if (toBank) {
        setTransferSheetVisible(true);
      } else {
        router.back();
      }
    } catch (e: any) {
      popup.alert({ title: 'Withdrawal failed', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Withdraw</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.amountWrap}>
        <Text style={styles.amount}>${amount || '0'}</Text>
        <Text style={[styles.hint, (overMax || underMin) && { color: colors.danger }]}>
          {supplied === null
            ? 'Loading your savings balance…'
            : overMax
              ? `You can withdraw up to ${formatUsd(supplied)}.`
              : underMin
                ? `Minimum withdrawal is ${formatUsd(MIN_WITHDRAW)}.`
                : `Savings balance: ${formatUsd(supplied)}`}
        </Text>
      </View>

      <View style={styles.bottom}>
        <View style={styles.presetRow}>
          {PRESETS.map((p) => {
            const active = value > 0 && Math.abs(value - presetAmount(p)) < 0.005 && !isFull;
            return (
              <Pressable
                key={p}
                onPress={() => onPreset(p)}
                disabled={!supplied}
                style={[styles.preset, active && styles.presetActive]}
              >
                <Text style={[styles.presetText, active && styles.presetTextActive]}>{p * 100}%</Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => onPreset('all')}
            disabled={!supplied}
            style={[styles.preset, isFull && value > 0 && styles.presetActive]}
          >
            <Text style={[styles.presetText, isFull && value > 0 && styles.presetTextActive]}>All</Text>
          </Pressable>
        </View>

        <AmountPad value={amount} onChange={setAmount} />
        <Button
          title="Withdraw"
          onPress={onWithdraw}
          disabled={!valid}
          loading={busy}
          style={{ marginTop: 8 }}
        />
        <Text style={styles.finePrint}>
          A {(WITHDRAW_FEE_RATE * 100).toFixed(1)}% fee applies on withdrawal · {formatUsd(MIN_WITHDRAW)} minimum.
        </Text>
      </View>

      <MethodSheet
        visible={transferSheetVisible}
        onClose={() => {
          setTransferSheetVisible(false);
          router.back();
        }}
        title="Transfer with"
        bankSubtitle="Withdraw to GCash or bank via InstaPay"
        debitSubtitle="Instant payout to Visa or Mastercard"
        externalSubtitle="Send USDC to another wallet"
        onSelectExternalWallet={() => {
          setTransferSheetVisible(false);
          router.push('/send');
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  amountWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  amount: { fontSize: 56, fontWeight: '800', color: colors.ink },
  hint: { color: colors.sub, fontSize: 14, marginTop: 8 },
  bottom: {},
  presetRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  preset: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
  },
  presetActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  presetText: { fontSize: 14, fontWeight: '700', color: colors.ink },
  presetTextActive: { color: '#fff' },
  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10 },
});
