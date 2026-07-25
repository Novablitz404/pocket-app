import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActivityItem } from '@/lib/stellar';
import { colors, formatUsd } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

export const ACTIVITY_META: Record<
  ActivityItem['kind'],
  { label: string; icon: keyof typeof Ionicons.glyphMap; sign: 1 | -1 }
> = {
  sent: { label: 'Sent', icon: 'arrow-up', sign: -1 },
  received: { label: 'Received', icon: 'arrow-down', sign: 1 },
  'cash-in': { label: 'Deposited', icon: 'add', sign: 1 },
  'cash-out': { label: 'Transferred', icon: 'business', sign: -1 },
  'earn-deposit': { label: 'Moved to Earn', icon: 'trending-up', sign: -1 },
  'earn-withdraw': { label: 'Withdrew from Earn', icon: 'trending-down', sign: 1 },
};
const META = ACTIVITY_META;

export function shortId(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function ActivityRow({ item }: { item: ActivityItem }) {
  const { nameFor } = useWallet();
  const meta = META[item.kind];
  const isP2P = item.kind === 'sent' || item.kind === 'received';
  const counterparty = nameFor(item.counterparty) ?? shortId(item.counterparty);
  const date = new Date(item.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const openDetail = () =>
    router.push({
      pathname: '/tx-detail',
      params: {
        id: item.id,
        kind: item.kind,
        amount: item.amount.toFixed(7),
        counterparty: item.counterparty,
        createdAt: item.createdAt,
        txHash: item.txHash,
        ...(item.memo ? { memo: item.memo } : {}),
      },
    } as any);

  return (
    <Pressable onPress={openDetail} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
      <View style={[styles.iconWrap, meta.sign === 1 && { backgroundColor: colors.accentSoft }]}>
        <Ionicons name={meta.icon} size={20} color={meta.sign === 1 ? colors.accentDark : colors.ink} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>
          {meta.label}
          {isP2P ? ` · ${counterparty}` : ''}
        </Text>
        <Text style={styles.date}>{date}</Text>
      </View>
      <Text style={[styles.amount, meta.sign === 1 && { color: colors.accentDark }]}>
        {meta.sign === 1 ? '+' : '-'}
        {formatUsd(item.amount)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 16, fontWeight: '600', color: colors.ink },
  date: { fontSize: 13, color: colors.sub, marginTop: 2 },
  amount: { fontSize: 16, fontWeight: '700', color: colors.ink },
});
