import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { ensureUnlocked } from '@/lib/biometrics';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const PARTNERS = [
  { id: 'gcash', label: 'GCash', icon: 'phone-portrait-outline' as const },
  { id: 'moneygram', label: 'MoneyGram', icon: 'storefront-outline' as const },
  { id: 'bank', label: 'Bank', icon: 'business-outline' as const },
];

export default function CashOut() {
  const { balance, cashOut } = useWallet();
  const popup = usePopup();
  const [amount, setAmount] = useState('');
  const [partner, setPartner] = useState(PARTNERS[0].id);
  const [busy, setBusy] = useState(false);

  const value = parseFloat(amount) || 0;
  const partnerLabel = PARTNERS.find((p) => p.id === partner)?.label;

  const onCashOut = async () => {
    if (!(await ensureUnlocked(`Transfer ${formatUsd(value)}`))) return;
    setBusy(true);
    try {
      await cashOut(value);
      await popup.alert({
        title: 'Transfer started',
        message: `${formatUsd(value)} is on its way to ${partnerLabel}.`,
        confirmText: 'Done',
      });
      router.back();
    } catch (e: any) {
      popup.alert({ title: 'Could not transfer', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Transfer</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.amountWrap}>
        <Text style={styles.amount}>${amount || '0'}</Text>
        <Text style={styles.balanceHint}>Available: {formatUsd(balance)}</Text>
      </View>

      <View style={styles.bottom}>
        <View style={styles.partners}>
          {PARTNERS.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => setPartner(p.id)}
              style={[styles.partner, partner === p.id && styles.partnerActive]}
            >
              <Ionicons
                name={p.icon}
                size={20}
                color={partner === p.id ? colors.accentDark : colors.sub}
              />
              <Text
                numberOfLines={1}
                style={[styles.partnerLabel, partner === p.id && { color: colors.accentDark }]}
              >
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <AmountPad value={amount} onChange={setAmount} />
        <Button
          title={value > 0 ? `Transfer ${formatUsd(value)}` : 'Transfer'}
          onPress={onCashOut}
          disabled={value <= 0 || value > balance}
          loading={busy}
          style={{ marginTop: 8 }}
        />
        <Text style={styles.finePrint}>Arrives at {partnerLabel} in minutes</Text>
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
  balanceHint: { color: colors.sub, fontSize: 14, marginTop: 6 },
  partners: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  partner: {
    flex: 1,
    flexDirection: 'column',
    gap: 6,
    alignItems: 'center',
    justifyContent: 'center',
    height: 64,
    paddingHorizontal: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  partnerActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  partnerLabel: { fontSize: 13, fontWeight: '600', color: colors.sub },
  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10 },
});
