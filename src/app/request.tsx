import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Keyboard, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { AmountPad } from '@/components/amount-pad';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { createRequest } from '@/lib/requests';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

type Mode = 'qr' | 'ask';

export default function Request() {
  const { publicKey, name, contacts, nameFor, profileFor, resolveUsername } = useWallet();
  const popup = usePopup();
  const [mode, setMode] = useState<Mode>('qr');
  const [amount, setAmount] = useState('');

  // "Ask someone" state — a specific person gets a push + an entry in their
  // Activity tab, unlike the passive QR above.
  const [askAmount, setAskAmount] = useState('');
  const [to, setTo] = useState('');
  const [toName, setToName] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);

  if (!publicKey) return null;

  const params = new URLSearchParams();
  if (parseFloat(amount)) params.set('amount', parseFloat(amount).toFixed(2));
  if (name) params.set('name', name);
  const query = params.toString();
  const payload = `remitt:${publicKey}${query ? `?${query}` : ''}`;

  const copyTag = async () => {
    await Clipboard.setStringAsync(publicKey);
    popup.alert({ title: 'Copied', message: 'Your Remitt tag is on the clipboard.' });
  };

  const share = () => {
    Share.share({
      message: `Pay me on Remitt${parseFloat(amount) ? ` ($${parseFloat(amount).toFixed(2)})` : ''}: ${payload}`,
    }).catch(() => {});
  };

  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setTo(text.trim());
  };

  const askValue = parseFloat(askAmount) || 0;
  const canAsk = askValue > 0 && to.trim().length > 0;

  const onAsk = async () => {
    setAsking(true);
    try {
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
        popup.alert({ title: "That's you", message: 'You can’t request money from yourself.' });
        return;
      }
      // create-request writes the row AND emits the payer's notification
      // server-side (unspoofable), so there's nothing to notify from here.
      await createRequest(publicKey, destination, askValue, note.trim() || undefined);
      await popup.alert({
        title: 'Request sent',
        message: `${label ?? 'They'} will see it in Remitt${note.trim() ? '.' : ' and get a notification.'}`,
        confirmText: 'Done',
      });
      router.back();
    } catch (e: any) {
      popup.alert({ title: 'Could not send the request', message: e?.message ?? 'Please try again.' });
    } finally {
      setAsking(false);
    }
  };

  const favorites = contacts.filter((c) => c.favorite).slice(0, 4);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Request money</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.segment}>
        <Pressable
          style={[styles.segmentBtn, mode === 'qr' && styles.segmentBtnActive]}
          onPress={() => setMode('qr')}
        >
          <Text style={[styles.segmentLabel, mode === 'qr' && styles.segmentLabelActive]}>My QR</Text>
        </Pressable>
        <Pressable
          style={[styles.segmentBtn, mode === 'ask' && styles.segmentBtnActive]}
          onPress={() => setMode('ask')}
        >
          <Text style={[styles.segmentLabel, mode === 'ask' && styles.segmentLabelActive]}>Ask someone</Text>
        </Pressable>
      </View>

      {mode === 'qr' ? (
        <Pressable style={styles.dismissArea} onPress={Keyboard.dismiss} accessible={false}>
          <View style={styles.qrCard}>
            <QRCode value={payload} size={220} backgroundColor="#fff" color={colors.ink} />
            <Text style={styles.qrName}>{name}</Text>
            <Text style={styles.qrHint}>
              Scan with Remitt to pay{parseFloat(amount) ? ` $${parseFloat(amount).toFixed(2)}` : ''}
            </Text>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Amount (optional)"
            placeholderTextColor={colors.sub}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />

          <View style={{ flex: 1 }} />
          <Button title="Share payment link" onPress={share} />
          <Button title="Copy my tag" variant="secondary" onPress={copyTag} style={{ marginTop: 10 }} />
        </Pressable>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.amountWrap}>
            <Text style={styles.amount}>${askAmount || '0'}</Text>
          </View>

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

          <TextInput
            style={[styles.input, { marginBottom: 16 }]}
            placeholder="What's it for? (optional)"
            placeholderTextColor={colors.sub}
            value={note}
            onChangeText={setNote}
          />

          <AmountPad value={askAmount} onChange={setAskAmount} />
          <Button
            title={askValue > 0 ? `Request ${formatUsd(askValue)}` : 'Request'}
            onPress={onAsk}
            disabled={!canAsk}
            loading={asking}
            style={{ marginTop: 8 }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  dismissArea: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginTop: 16,
  },
  segmentBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: 'center' },
  segmentBtnActive: { backgroundColor: colors.accentSoft },
  segmentLabel: { fontSize: 14, fontWeight: '700', color: colors.sub },
  segmentLabelActive: { color: colors.accentDark },
  qrCard: {
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: 28,
    marginTop: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  qrName: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 16 },
  qrHint: { fontSize: 13, color: colors.sub, marginTop: 4 },
  amountWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 20 },
  amount: { fontSize: 48, fontWeight: '800', color: colors.ink },
  favorites: { flexDirection: 'row', justifyContent: 'flex-start', gap: 24, marginBottom: 14 },
  favorite: { alignItems: 'center', gap: 6, maxWidth: 72 },
  favoriteLabel: { fontSize: 12, fontWeight: '600', color: colors.sub },
  recipientRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
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
    marginTop: 16,
  },
  iconBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
});
