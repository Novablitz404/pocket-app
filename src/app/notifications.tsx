import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type InboxNotification,
} from '@/lib/notifications';
import { colors, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  received: 'arrow-down-circle',
  request: 'cash',
  yield: 'trending-up',
  announcement: 'megaphone',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function Row({ item, onPress }: { item: InboxNotification; onPress: () => void }) {
  const type = typeof item.data.type === 'string' ? item.data.type : undefined;
  const icon = (type ? ICONS[type] : undefined) ?? 'notifications';
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
      {!item.read && <View style={styles.unreadDot} />}
      <View style={[styles.iconWrap, item.read && { backgroundColor: colors.border }]}>
        <Ionicons name={icon} size={20} color={item.read ? colors.sub : colors.accentDark} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, !item.read && { fontWeight: '800' }]}>{item.title}</Text>
        <Text style={styles.rowBody} numberOfLines={2}>
          {item.body}
        </Text>
      </View>
      <Text style={styles.rowTime}>{timeAgo(item.createdAt)}</Text>
    </Pressable>
  );
}

/** In-app inbox for the bell icon: the same events push would carry, so it
 *  works whether or not push itself is reachable on this build. */
export default function NotificationsScreen() {
  const { publicKey } = useWallet();
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!publicKey) return;
    setItems(await getNotifications(publicKey));
  }, [publicKey]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const onPressRow = (item: InboxNotification) => {
    if (!item.read) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
      markNotificationRead(item.id).catch(() => {});
    }
    const type = item.data.type;
    if (type === 'request' && typeof item.data.requestId === 'string') {
      router.push({
        pathname: '/send',
        params: {
          to: item.data.from,
          toName: item.data.fromName,
          amount: item.data.amount,
          requestId: item.data.requestId,
        },
      } as any);
    } else if (type === 'received' || type === 'yield') {
      router.push(type === 'yield' ? '/(tabs)/earn' : '/(tabs)/activity');
    }
  };

  const onMarkAllRead = () => {
    if (!publicKey) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    markAllNotificationsRead(publicKey).catch(() => {});
  };

  const hasUnread = items.some((n) => !n.read);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Text style={styles.title}>Notifications</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.ink} />
        </Pressable>
      </View>
      {hasUnread && (
        <Pressable onPress={onMarkAllRead} hitSlop={8} style={{ alignSelf: 'flex-end', marginBottom: 8 }}>
          <Text style={styles.markAll}>Mark all read</Text>
        </Pressable>
      )}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <Row item={item} onPress={() => onPressRow(item)} />}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={{ paddingTop: 60, alignItems: 'center' }}>
            <Text style={styles.empty}>Nothing here yet.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  markAll: { fontSize: 13, fontWeight: '700', color: colors.accentDark },
  list: { paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  unreadDot: {
    position: 'absolute',
    left: -12,
    top: '50%',
    marginTop: -3,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  rowBody: { fontSize: 13, color: colors.sub, marginTop: 2 },
  rowTime: { fontSize: 12, color: colors.sub },
  empty: { color: colors.sub, fontSize: 15 },
});
