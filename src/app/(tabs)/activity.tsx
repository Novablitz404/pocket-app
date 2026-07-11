import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityRow } from '@/components/activity-row';
import { Button } from '@/components/button';
import { declineRequest, getPendingRequests, type PaymentRequest } from '@/lib/requests';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

function RequestCard({ request, onDecline }: { request: PaymentRequest; onDecline: (id: string) => void }) {
  const { nameFor } = useWallet();
  const fromName = nameFor(request.fromAddress) ?? `${request.fromAddress.slice(0, 4)}…`;

  const pay = () =>
    router.push({
      pathname: '/send',
      params: {
        to: request.fromAddress,
        toName: fromName,
        amount: request.amount.toFixed(2),
        requestId: request.id,
      },
    } as any);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>
        <Text style={{ fontWeight: '800' }}>{fromName}</Text> asked for {formatUsd(request.amount)}
      </Text>
      {request.note ? <Text style={styles.cardNote}>{request.note}</Text> : null}
      <View style={styles.cardActions}>
        <Button title="Pay" onPress={pay} style={{ flex: 1 }} />
        <Button title="Decline" variant="secondary" onPress={() => onDecline(request.id)} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

export default function Activity() {
  const { activity, publicKey, refresh } = useWallet();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);

  const loadRequests = useCallback(async () => {
    if (!publicKey) return;
    setRequests(await getPendingRequests(publicKey));
  }, [publicKey]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), loadRequests()]);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, loadRequests]);

  // Silent decline: no notification back to the requester, it just stops
  // showing up here.
  const onDecline = useCallback((id: string) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
    declineRequest(id).catch(() => {});
  }, []);

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      <Text style={styles.title}>Activity</Text>
      <FlatList
        data={activity}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ActivityRow item={item} />}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          requests.length > 0 ? (
            <View style={styles.requests}>
              {requests.map((r) => (
                <RequestCard key={r.id} request={r} onDecline={onDecline} />
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={{ paddingTop: 60, alignItems: 'center' }}>
            <Text style={styles.empty}>Nothing here yet.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  title: { fontSize: 28, fontWeight: '800', color: colors.ink, padding: 20, paddingBottom: 8 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  empty: { color: colors.sub, fontSize: 15 },
  requests: { gap: 10, marginBottom: 16 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    gap: 8,
  },
  cardTitle: { fontSize: 15, color: colors.ink },
  cardNote: { fontSize: 13, color: colors.sub },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
});
