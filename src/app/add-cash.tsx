import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const PARTNERS = [
  { id: 'gcash', label: 'GCash', icon: 'phone-portrait-outline' as const },
  { id: 'moneygram', label: 'MoneyGram', icon: 'storefront-outline' as const },
  { id: 'card', label: 'Debit card', icon: 'card-outline' as const },
];

export default function AddCash() {
  const { addCash, accountVerified, verifyAccount } = useWallet();
  const popup = usePopup();
  const [amount, setAmount] = useState('');
  const [partner, setPartner] = useState(PARTNERS[0].id);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const value = parseFloat(amount) || 0;

  const onVerify = async () => {
    setVerifying(true);
    try {
      await verifyAccount();
    } catch (e: any) {
      popup.alert({ title: 'Could not verify', message: e?.message ?? 'Please try again.' });
    } finally {
      setVerifying(false);
    }
  };

  const onAdd = async () => {
    setBusy(true);
    try {
      await addCash(value);
      await popup.alert({
        title: 'Cash added',
        message: `${formatUsd(value)} is in your account.`,
        confirmText: 'Done',
      });
      router.back();
    } catch (e: any) {
      popup.alert({ title: 'Could not add cash', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  if (!accountVerified) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>Verify your account</Text>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.ink} />
          </Pressable>
        </View>
        <View style={styles.amountWrap}>
          <Text style={styles.balanceHint}>
            Verifying opens your account and unlocks adding cash.
          </Text>
        </View>
        <View style={styles.bottom}>
          <Button title="Verify" onPress={onVerify} loading={verifying} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Add cash</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.amountWrap}>
        <Text style={styles.amount}>${amount || '0'}</Text>
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
          title={value > 0 ? `Add ${formatUsd(value)}` : 'Add cash'}
          onPress={onAdd}
          disabled={value <= 0}
          loading={busy}
          style={{ marginTop: 8 }}
        />
        <Text style={styles.finePrint}>Funds are available the moment they arrive</Text>
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
  balanceHint: { color: colors.sub, fontSize: 14, marginTop: 8, textAlign: 'center' },
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
