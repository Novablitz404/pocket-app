import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '@/components/avatar';
import { ACTIVITY_META, shortId } from '@/components/activity-row';
import { usePopup } from '@/components/popup';
import type { ActivityItem } from '@/lib/stellar';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const EXPLORER_BASE = 'https://stellar.expert/explorer/testnet/tx/';

/** Detail sheet for one activity row: counterparty, amount, memo, date,
 *  status, and (tucked under "Advanced") the raw Stellar tx hash + a link to
 *  the public block explorer. Reached by tapping any ActivityRow. */
export default function TxDetail() {
  const params = useLocalSearchParams<{
    id: string;
    kind: ActivityItem['kind'];
    amount: string;
    counterparty: string;
    createdAt: string;
    txHash: string;
    memo?: string;
  }>();
  const { nameFor, profileFor } = useWallet();
  const popup = usePopup();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const meta = ACTIVITY_META[params.kind];
  const isP2P = params.kind === 'sent' || params.kind === 'received';
  const isEarn = params.kind === 'earn-deposit' || params.kind === 'earn-withdraw';
  const amount = parseFloat(params.amount);
  const name = isP2P ? (nameFor(params.counterparty) ?? shortId(params.counterparty)) : null;
  const profile = isP2P ? profileFor(params.counterparty) : null;
  const date = new Date(params.createdAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const copyHash = async () => {
    await Clipboard.setStringAsync(params.txHash);
    popup.alert({ title: 'Copied', message: 'Transaction hash is on the clipboard.' });
  };

  const openExplorer = () => Linking.openURL(`${EXPLORER_BASE}${params.txHash}`).catch(() => {});

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Transaction</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.hero}>
        {isP2P ? (
          <Avatar name={name ?? '?'} uri={profile?.avatarUrl} size={64} />
        ) : (
          <View style={[styles.iconWrap, meta.sign === 1 && { backgroundColor: colors.accentSoft }]}>
            <Ionicons name={meta.icon} size={30} color={meta.sign === 1 ? colors.accentDark : colors.ink} />
          </View>
        )}
        <Text style={[styles.amount, meta.sign === 1 && { color: colors.accentDark }]}>
          {meta.sign === 1 ? '+' : '-'}
          {formatUsd(amount)}
        </Text>
        <Text style={styles.label}>
          {meta.label}
          {name ? ` · ${name}` : ''}
        </Text>
      </View>

      <View style={styles.rows}>
        <Row label="Date" value={date} />
        <Row label="Status" value="Completed" valueColor={colors.accentDark} />
        {isP2P && <Row label={params.kind === 'sent' ? 'To' : 'From'} value={name ?? shortId(params.counterparty)} />}
        {isEarn && <Row label="Pool" value="Blend USDC" />}
        {params.memo && <Row label="Memo" value={params.memo} />}
        <Row label="Network fee" value="Free · covered by Remitt" />
      </View>

      <Pressable onPress={() => setShowAdvanced((s) => !s)} style={styles.advancedToggle}>
        <Text style={styles.advancedToggleLabel}>Advanced</Text>
        <Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={16} color={colors.sub} />
      </Pressable>

      {showAdvanced && (
        <View style={styles.advanced}>
          <Text style={styles.hashLabel}>Stellar transaction hash</Text>
          <Pressable onPress={copyHash}>
            <Text style={styles.hash} numberOfLines={1}>
              {params.txHash}
            </Text>
          </Pressable>
          <Pressable onPress={openExplorer} style={styles.explorerBtn}>
            <Text style={styles.explorerLabel}>View on Stellar Explorer</Text>
            <Ionicons name="open-outline" size={16} color={colors.accentDark} />
          </Pressable>
        </View>
      )}

      <View style={{ flex: 1 }} />
    </SafeAreaView>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor && { color: valueColor }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  hero: { alignItems: 'center', paddingVertical: 28, gap: 8 },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amount: { fontSize: 36, fontWeight: '800', color: colors.ink, marginTop: 8 },
  label: { fontSize: 15, color: colors.sub },
  rows: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 12,
  },
  rowLabel: { fontSize: 14, color: colors.sub },
  rowValue: { fontSize: 14, fontWeight: '600', color: colors.ink, flexShrink: 1, textAlign: 'right' },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 16,
  },
  advancedToggleLabel: { fontSize: 13, fontWeight: '600', color: colors.sub },
  advanced: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 10,
  },
  hashLabel: { fontSize: 12, color: colors.sub },
  hash: { fontSize: 13, color: colors.ink, fontWeight: '600' },
  explorerBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  explorerLabel: { fontSize: 14, fontWeight: '700', color: colors.accentDark },
});
