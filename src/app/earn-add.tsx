import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { Button } from '@/components/button';
import { MethodSheet } from '@/components/method-sheet';
import { usePopup } from '@/components/popup';
import { ensureUnlocked } from '@/lib/biometrics';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

/** Add Money: move wallet USDC into savings (Blend). The savings account is
 *  funded only from the wallet — cash in first (GCash / bank), then move it
 *  into the pool. Mirrors the add-cash screen: big amount on top, keypad below. */
export default function EarnAdd() {
  const { balance, earnDeposit } = useWallet();
  const popup = usePopup();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [depositSheetVisible, setDepositSheetVisible] = useState(false);

  const value = parseFloat(amount) || 0;

  const onMove = async () => {
    if (value <= 0) return;
    if (value > balance) {
      popup.alert({
        title: 'Not enough in your wallet',
        message: `You can move up to ${formatUsd(balance)} into savings. Deposit first to move more.`,
      });
      return;
    }
    if (!(await ensureUnlocked(`Move ${formatUsd(value)} into savings`))) return;
    setBusy(true);
    try {
      await earnDeposit(value);
      await popup.alert({
        title: 'Now earning',
        message: `${formatUsd(value)} is in your savings earning yield.`,
      });
      router.back();
    } catch (e: any) {
      popup.alert({ title: 'Could not add funds', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Add Money</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.amountWrap}>
        <Text style={styles.amount}>${amount || '0'}</Text>
        <Text style={styles.hint}>Available in wallet: {formatUsd(balance)}</Text>
      </View>

      <View style={styles.bottom}>
        <Pressable onPress={() => setDepositSheetVisible(true)} style={styles.methodRow}>
          <Ionicons name="phone-portrait-outline" size={18} color={colors.accentDark} />
          <Text style={styles.methodLabel}>Wallet low? Deposit via GCash / bank</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.accentDark} />
        </Pressable>

        <AmountPad value={amount} onChange={setAmount} />
        <Button
          title={value > 0 ? `Move ${formatUsd(value)} to savings` : 'Move to savings'}
          onPress={onMove}
          disabled={value <= 0}
          loading={busy}
          style={{ marginTop: 8 }}
        />
        <Text style={styles.finePrint}>Earns the pool’s live rate · withdraw anytime</Text>
      </View>

      <MethodSheet
        visible={depositSheetVisible}
        onClose={() => setDepositSheetVisible(false)}
        title="Deposit with"
        bankSubtitle="GCash, bank transfer via InstaPay"
        debitSubtitle="Instant, via Visa or Mastercard"
        externalSubtitle="Send USDC from another wallet"
        onSelectExternalWallet={() => {
          setDepositSheetVisible(false);
          router.push('/cash-in-wallet');
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
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  methodLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.ink },
  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10 },
});
