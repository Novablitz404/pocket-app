import { Ionicons } from '@expo/vector-icons';
import { Link, router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityRow } from '@/components/activity-row';
import { Avatar } from '@/components/avatar';
import { Skeleton } from '@/components/skeleton';
import { getNotifications } from '@/lib/notifications';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const ACTIONS: { label: string; icon: keyof typeof Ionicons.glyphMap; href: string }[] = [
  { label: 'Send', icon: 'arrow-up', href: '/send' },
  { label: 'Request', icon: 'arrow-down', href: '/request' },
  { label: 'Add cash', icon: 'add', href: '/add-cash' },
  { label: 'Cash out', icon: 'cash-outline', href: '/cash-out' },
];

export default function Home() {
  const { name, avatarUrl, accountVerified, balance, activity, balanceLoaded, publicKey, refresh } = useWallet();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  const loadUnread = useCallback(async () => {
    if (!publicKey) return;
    const items = await getNotifications(publicKey);
    setHasUnread(items.some((n) => !n.read));
  }, [publicKey]);

  // Bell badge should reflect anything read from the inbox screen too, so
  // refetch every time Home regains focus, not just on mount.
  useFocusEffect(
    useCallback(() => {
      loadUnread();
    }, [loadUnread]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), loadUnread()]);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, loadUnread]);

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      {/* Outside the ScrollView so pull-to-refresh spins below the header,
          matching the Activity tab. */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Avatar name={name ?? ''} uri={avatarUrl} size={44} verified={accountVerified} />
          <Text style={styles.greeting}>{name ? `Hi, ${name.split(' ')[0]}` : 'Welcome'}</Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable onPress={() => router.push('/notifications')} hitSlop={12} style={{ marginRight: 18 }}>
            <Ionicons name="notifications-outline" size={22} color={colors.sub} />
            {hasUnread && <View style={styles.unreadDot} />}
          </Pressable>
          <Pressable onPress={() => router.push('/scan')} hitSlop={12}>
            <Ionicons name="qr-code-outline" size={22} color={colors.sub} />
          </Pressable>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>Account balance</Text>
          {balanceLoaded ? (
            <Text style={styles.balance}>{formatUsd(balance)}</Text>
          ) : (
            <Skeleton width={180} height={44} radius={10} style={{ marginTop: 8, marginBottom: 2 }} />
          )}
          <Text style={styles.balanceSub}>Tracks the US dollar, dollar-for-dollar · available instantly</Text>
        </View>

        <View style={styles.actions}>
          {ACTIONS.map((action) => (
            <Pressable
              key={action.label}
              style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}
              onPress={() => router.push(action.href as any)}
            >
              <View style={styles.actionIcon}>
                <Ionicons name={action.icon} size={22} color={colors.accentDark} />
              </View>
              <Text style={styles.actionLabel}>{action.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent activity</Text>
          <Link href="/(tabs)/activity" style={styles.sectionLink}>
            See all
          </Link>
        </View>
        {activity.length === 0 ? (
          <Text style={styles.empty}>No activity yet. Add cash to get started.</Text>
        ) : (
          activity.slice(0, 5).map((item) => <ActivityRow key={item.id} item={item} />)
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 20, paddingTop: 0, paddingBottom: 40 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  unreadDot: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    borderWidth: 1.5,
    borderColor: colors.bg,
  },
  greeting: { fontSize: 20, fontWeight: '700', color: colors.ink },
  balanceCard: {
    backgroundColor: colors.ink,
    borderRadius: radius.lg,
    padding: 24,
  },
  balanceLabel: { color: '#9DB1A6', fontSize: 14, fontWeight: '600' },
  balance: { color: '#fff', fontSize: 44, fontWeight: '800', marginTop: 6 },
  balanceSub: { color: '#9DB1A6', fontSize: 13, marginTop: 6 },
  actions: { flexDirection: 'row', marginTop: 20, gap: 10 },
  action: { flex: 1, alignItems: 'center', gap: 8 },
  actionIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 13, fontWeight: '600', color: colors.ink },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 28,
    marginBottom: 4,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.ink },
  sectionLink: { color: colors.accentDark, fontWeight: '600', fontSize: 14 },
  empty: { color: colors.sub, marginTop: 16, fontSize: 15 },
});
