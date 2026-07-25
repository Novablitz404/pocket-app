import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { ensureUnlocked } from '@/lib/biometrics';
import { markPaid } from '@/lib/requests';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

export default function Send() {
  const params = useLocalSearchParams<{ to?: string; amount?: string; toName?: string; requestId?: string }>();
  const { balance, publicKey, sendMoney, resolveUsername, contacts, nameFor, profileFor } = useWallet();
  const popup = usePopup();
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [toName, setToName] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (params.to) setTo(params.to);
    if (params.amount) setAmount(params.amount);
    if (params.toName) setToName(params.toName);
  }, [params.to, params.amount, params.toName]);

  const value = parseFloat(amount) || 0;
  const canSend = value > 0 && value <= balance && to.trim().length > 0;
  // A raw Stellar address (vs. a Pocket username) means this is going to an
  // external wallet, not another Pocket user — those sends are final, so
  // warn before the amount pad even opens the possibility of a typo mistake.
  const isExternalAddress = /^G[A-Z0-9]{55}$/.test(to.trim());

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setTo(text.trim());
  };

  const onSend = async () => {
    setSending(true);
    try {
      // Accept either a raw Stellar address or a username. A 56-char "G..."
      // string is an address; anything else is looked up in the directory.
      const entered = to.trim();
      const isAddress = /^G[A-Z0-9]{55}$/.test(entered);
      let destination = entered;
      let label = toName;
      if (!isAddress) {
        const resolved = await resolveUsername(entered);
        if (!resolved) {
          popup.alert({ title: 'User not found', message: `No Remitt user named "${entered}".` });
          return;
        }
        destination = resolved;
        label = entered;
      }
      if (destination === publicKey) {
        popup.alert({
          title: "That's you",
          message: 'You can’t send money to your own account.',
        });
        return;
      }
      if (!(await ensureUnlocked(`Send ${formatUsd(value)}`))) return;
      await sendMoney(destination, value);
      if (params.requestId) markPaid(params.requestId).catch(() => {});
      await popup.alert({
        title: 'Sent!',
        message: `${formatUsd(value)} delivered instantly${label ? ` to ${label}` : ''}.`,
        confirmText: 'Done',
      });
      router.back();
    } catch (e: any) {
      popup.alert({ title: 'Could not send', message: e?.message ?? 'Please try again.' });
    } finally {
      setSending(false);
    }
  };

  // Favorited contacts, most recent first, shown like Add cash's partner row.
  const favorites = contacts.filter((c) => c.favorite).slice(0, 4);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Send money</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.amountWrap}>
        <Text style={styles.amount}>${amount || '0'}</Text>
        <Text style={styles.balanceHint}>Balance: {formatUsd(balance)}</Text>
      </View>

      <View style={styles.bottom}>
        {favorites.length > 0 && (
          <View style={styles.favorites}>
            {favorites.map((fav) => {
              const favName = nameFor(fav.address) ?? `${fav.address.slice(0, 4)}…`;
              const selected = to === fav.address;
              return (
                <Pressable
                  key={fav.address}
                  onPress={() => {
                    setTo(fav.address);
                    setToName(favName);
                  }}
                  style={({ pressed }) => [styles.favorite, pressed && { opacity: 0.6 }]}
                >
                  <Avatar name={favName} uri={profileFor(fav.address)?.avatarUrl} size={44} />
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.favoriteLabel,
                      selected && { color: colors.accentDark, fontWeight: '800' },
                    ]}
                  >
                    {favName.split(' ')[0]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <View style={styles.recipientRow}>
          <TextInput
            style={styles.input}
            placeholder="Username or address"
            placeholderTextColor={colors.sub}
            value={toName ?? to}
            onChangeText={(text) => {
              setToName(null);
              setTo(text);
            }}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={styles.iconBtn} onPress={paste} hitSlop={8}>
            <Ionicons name="clipboard-outline" size={20} color={colors.accentDark} />
          </Pressable>
        </View>

        {isExternalAddress && (
          <View style={styles.warnCard}>
            <Ionicons name="warning-outline" size={18} color={colors.accentDark} />
            <Text style={styles.warnText}>
              Double-check this address — it&rsquo;s not a Pocket user. Sends to an external wallet are final and
              cannot be reversed or refunded, not even by support.
            </Text>
          </View>
        )}

        <AmountPad value={amount} onChange={setAmount} />
        <Button
          title={value > 0 ? `Send ${formatUsd(value)}` : 'Send'}
          onPress={onSend}
          disabled={!canSend}
          loading={sending}
          style={{ marginTop: 8 }}
        />
        <Text style={styles.finePrint}>Free · arrives in ~5 seconds</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  // Same skeleton as Add cash: amount centered in the flexible middle,
  // pickers + pad + button pinned to the bottom.
  amountWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottom: {},
  amount: { fontSize: 56, fontWeight: '800', color: colors.ink },
  balanceHint: { color: colors.sub, fontSize: 14, marginTop: 6 },
  favorites: { flexDirection: 'row', justifyContent: 'flex-start', gap: 24, marginBottom: 14 },
  favorite: { alignItems: 'center', gap: 6, maxWidth: 72 },
  favoriteLabel: { fontSize: 12, fontWeight: '600', color: colors.sub },
  recipientRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 },
  warnCard: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginBottom: 16,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  warnText: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.accentDark, lineHeight: 18 },
  input: {
    flex: 1,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    fontSize: 15,
    color: colors.ink,
  },
  iconBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10 },
});
