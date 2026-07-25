import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { USDC_ISSUER } from '@/lib/stellar-config';
import { colors, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

/** First6…last6 of a Stellar key/address — matches how it's shown elsewhere. */
function shorten(key: string): string {
  return `${key.slice(0, 6)}…${key.slice(-6)}`;
}

export default function CashInWallet() {
  const { publicKey } = useWallet();
  const popup = usePopup();

  if (!publicKey) return null;

  const copyAddress = async () => {
    await Clipboard.setStringAsync(publicKey);
    popup.alert({ title: 'Copied', message: 'Your wallet address is on the clipboard.' });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>External wallet</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <View style={styles.qrCard}>
          <QRCode value={publicKey} size={200} backgroundColor="#fff" color={colors.ink} />
        </View>

        <Pressable style={styles.addressRow} onPress={copyAddress}>
          <Text style={styles.address} numberOfLines={1}>
            {shorten(publicKey)}
          </Text>
          <Ionicons name="copy-outline" size={18} color={colors.accentDark} />
        </Pressable>

        <View style={styles.warnCard}>
          <Ionicons name="warning-outline" size={18} color={colors.accentDark} />
          <Text style={styles.warnText}>
            Only send USDC on the Stellar network (issuer {shorten(USDC_ISSUER)}) to this address. Sending any
            other asset, the wrong network, or to the wrong address is final — it cannot be reversed or refunded,
            not even by support.
          </Text>
        </View>
      </View>

      <View style={styles.bottom}>
        <Button title="Done" onPress={() => router.back()} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  qrCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radius.full,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  address: { fontSize: 15, fontWeight: '700', color: colors.ink, letterSpacing: 0.5 },
  warnCard: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 24,
    padding: 14,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  warnText: { flex: 1, fontSize: 13, fontWeight: '500', color: colors.accentDark, lineHeight: 18 },
  bottom: {},
});
