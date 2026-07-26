import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePopup } from '@/components/popup';
import { type SnapshotPoint, SavingsChart, bucketize } from '@/components/savings-chart';
import { Skeleton } from '@/components/skeleton';
import { FALLBACK_APY, getEarnState } from '@/lib/earn-vault';
import { getNetDeposited, getSnapshots, maybeRecordSnapshot } from '@/lib/earn-ledger';
import { formatLocal } from '@/lib/fx';
import { colors, formatUsd, radius } from '@/lib/theme';
import { consumePendingHomeRange } from '@/lib/ui-state';
import { useWallet } from '@/lib/wallet-context';

const RANGES = ['1W', '1M', '1Y', 'All'] as const;
type Range = (typeof RANGES)[number];

const DAY_MS = 24 * 3600 * 1000;
// Window length and bar count per range: 1W reads as one bar per day.
const RANGE_CONFIG: Record<Range, { ms: number; bars: number }> = {
  '1W': { ms: 7 * DAY_MS, bars: 7 },
  '1M': { ms: 30 * DAY_MS, bars: 10 },
  '1Y': { ms: 365 * DAY_MS, bars: 12 },
  All: { ms: Infinity, bars: 12 },
};

// Last-known earn data, cached on-device per address so re-opening the tab
// paints the balance and chart instantly instead of flashing blank while the
// network catches up. The live fetch still runs on focus and overwrites this.
const cacheKey = (address: string) => `earn:home:${address}`;
interface HomeCache {
  supplied: number;
  apy: number;
  netDeposited: number | null;
  snapshots: SnapshotPoint[];
}

/** Dollar format with enough precision for small accruals (e.g. $0.0031). */
function formatEarnings(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return formatUsd(amount);
}

function formatDay(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Baseline-aligned placeholder bars, so the first-ever load reads as a chart
// warming up rather than an empty gap. Heights are static (a rising shape).
const SKELETON_BARS = [64, 96, 78, 132, 118, 168, 150];
function ChartSkeleton() {
  return (
    <View style={styles.chartSkeleton}>
      {SKELETON_BARS.map((h, i) => (
        <View key={i} style={styles.chartSkeletonSlot}>
          <Skeleton width="100%" height={h} radius={12} />
        </View>
      ))}
    </View>
  );
}

export default function Earn() {
  const { publicKey, activated, localCurrency, localRate, refresh } = useWallet();
  const popup = usePopup();
  const insets = useSafeAreaInsets();

  const [supplied, setSupplied] = useState(0);
  const [apy, setApy] = useState(FALLBACK_APY);
  const [netDeposited, setNetDeposited] = useState<number | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotPoint[]>([]);
  const [loadingState, setLoadingState] = useState(true);
  const [range, setRange] = useState<Range>('1W');
  const [selectedBar, setSelectedBar] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Once the live fetch has landed we stop letting the cache read (which may
  // resolve later) clobber fresher on-chain values.
  const hydratedRef = useRef(false);

  const load = useCallback(async () => {
    if (!publicKey || !activated) {
      setLoadingState(false);
      return;
    }
    try {
      const [s, net] = await Promise.all([getEarnState(publicKey), getNetDeposited(publicKey)]);
      hydratedRef.current = true;
      setSupplied(s.supplied);
      setApy(s.apy);
      setNetDeposited(net);
      setLoadingState(false);
      // Fire-and-forget: log today's point, then load the history that feeds
      // the bar chart (balance plus principal, so buckets can tell deposits
      // and withdrawals apart from interest).
      maybeRecordSnapshot(publicKey, s.supplied, net ?? 0).catch(() => {});
      getSnapshots(publicKey)
        .then((snaps) => {
          const points = snaps.map((snap) => ({
            t: new Date(snap.createdAt).getTime(),
            v: snap.supplied,
            net: snap.netDeposited,
          }));
          setSnapshots(points);
          AsyncStorage.setItem(
            cacheKey(publicKey),
            JSON.stringify({ supplied: s.supplied, apy: s.apy, netDeposited: net, snapshots: points }),
          ).catch(() => {});
        })
        .catch(() => {});
    } catch {
      // leave last-known values
      setLoadingState(false);
    }
  }, [publicKey, activated]);

  // Paint last-known values immediately on mount so the tab never opens blank;
  // the live fetch above replaces them a moment later.
  useEffect(() => {
    if (!publicKey || !activated) return;
    let cancelled = false;
    AsyncStorage.getItem(cacheKey(publicKey))
      .then((raw) => {
        if (cancelled || !raw || hydratedRef.current) return;
        const c: HomeCache = JSON.parse(raw);
        setSupplied(c.supplied);
        setApy(c.apy);
        setNetDeposited(c.netDeposited);
        setSnapshots(c.snapshots ?? []);
        setLoadingState(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [publicKey, activated]);

  useFocusEffect(
    useCallback(() => {
      // The simulate screen's range pills hand their pick back through here.
      const pending = consumePendingHomeRange();
      if (pending) {
        setRange(pending);
        setSelectedBar(null);
      }
      load();
    }, [load]),
  );

  const bars = useMemo(() => {
    if (snapshots.length === 0) return [];
    const { ms, bars: count } = RANGE_CONFIG[range];
    const end = Date.now();
    const start = ms === Infinity ? snapshots[0].t : end - ms;
    return bucketize(snapshots, count, start, end);
  }, [snapshots, range]);

  const onPickRange = (r: Range) => {
    setRange(r);
    setSelectedBar(null);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), load()]);
    } finally {
      setRefreshing(false);
    }
  }, [refresh, load]);

  const onApyInfo = () =>
    popup.alert({
      title: `Earning ${(apy * 100).toFixed(2)}% APY`,
      message:
        'Your savings are supplied to the Blend lending pool on Stellar and earn its live rate. The rate moves with the pool; interest accrues continuously and you can withdraw anytime.',
    });


  // Interest is the only thing that changes a Blend position's value, so
  // earnings are exactly the on-chain balance minus the recorded principal.
  const totalEarned =
    netDeposited !== null && supplied > 0 ? Math.max(0, supplied - netDeposited) : null;

  // The earned line follows the pinned bar (that bucket's accrual and date);
  // unpinned it shows the total earned to date.
  const selBar = selectedBar !== null ? bars[selectedBar] : null;
  const earnedAmount = selBar ? selBar.earned : totalEarned;
  const earnedDate = selBar ? formatDay(selBar.t) : formatDay(Date.now());

  const [whole, cents] = formatUsd(supplied).split('.');
  const hasPosition = supplied > 0.0000001;

  return (
    <View style={[styles.safe, { paddingTop: insets.top + 8 }]}>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        <Pressable onPress={onApyInfo} style={styles.apyRow} hitSlop={6}>
          <Ionicons name="rocket" size={16} color={colors.sub} />
          <Text style={styles.apyText}>Earning {(apy * 100).toFixed(2)}%</Text>
          <Ionicons name="information-circle-outline" size={16} color={colors.sub} />
        </Pressable>

        {loadingState ? (
          <Skeleton width={240} height={64} radius={14} style={{ alignSelf: 'center', marginTop: 14 }} />
        ) : (
          <>
            <Text style={styles.balance}>
              {whole}
              <Text style={styles.balanceCents}>.{cents}</Text>
            </Text>
            {localCurrency && localRate != null && (
              <Text style={styles.balanceLocal}>≈ {formatLocal(supplied, localCurrency, localRate)}</Text>
            )}
          </>
        )}

        {earnedAmount !== null ? (
          <View style={styles.earnedRow}>
            <View style={styles.earnedDot} />
            <Text style={styles.earnedText}>{formatEarnings(earnedAmount)} Earned</Text>
            <Text style={styles.earnedSub}> {earnedDate}</Text>
          </View>
        ) : (
          !loadingState && (
            <Text style={styles.startHint}>{supplied <= 0 ? 'Add funds to start earning.' : ' '}</Text>
          )
        )}

        <View style={styles.actions}>
          <Pressable
            onPress={() => router.push('/earn-withdraw' as any)}
            disabled={!hasPosition}
            style={({ pressed }) => [
              styles.pill,
              styles.pillSecondary,
              !hasPosition && styles.pillDisabled,
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.pillText, styles.pillSecondaryText]}>Withdraw</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/earn-add' as any)}
            style={({ pressed }) => [styles.pill, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.pillText}>Add Funds</Text>
          </Pressable>
        </View>

        <View style={styles.chartWrap}>
          {loadingState ? (
            <ChartSkeleton />
          ) : (
            <SavingsChart bars={bars} selected={selectedBar} onSelect={setSelectedBar} />
          )}
        </View>

        <View style={styles.rangeRow}>
          {RANGES.map((r) => (
            <Pressable
              key={r}
              onPress={() => onPickRange(r)}
              style={[styles.rangeBtn, range === r && styles.rangeBtnActive]}
            >
              <Text style={[styles.rangeText, range === r && styles.rangeTextActive]}>{r}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => router.push('/simulate' as any)} style={styles.rangeBtn}>
            <Text style={styles.rangeText}>
              Future<Text style={styles.futureStar}>+</Text>
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
  bodyContent: { flexGrow: 1, paddingHorizontal: 24 },

  apyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 20,
  },
  apyText: { fontSize: 17, fontWeight: '600', color: colors.sub },

  balance: {
    fontSize: 64,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
    marginTop: 10,
    letterSpacing: -1.5,
  },
  balanceCents: { fontSize: 40 },
  balanceLocal: { color: colors.sub, fontSize: 16, fontWeight: '600', textAlign: 'center', marginTop: 2 },

  earnedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 10,
  },
  earnedDot: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: colors.accentSoft },
  earnedText: { fontSize: 17, fontWeight: '800', color: colors.accent },
  earnedSub: { fontSize: 17, fontWeight: '500', color: colors.sub },
  startHint: { textAlign: 'center', color: colors.sub, fontSize: 16, marginTop: 10 },

  chartWrap: { flex: 1, justifyContent: 'center', marginTop: 12, paddingBottom: 24 },
  chartSkeleton: { height: 300, flexDirection: 'row', alignItems: 'flex-end', gap: 14, paddingHorizontal: 4 },
  chartSkeletonSlot: { flex: 1 },

  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    marginBottom: 24,
    // Lift the pills up visually WITHOUT feeding the flex layout (the chart is
    // flex:1, so a negative margin here would grow its space and push the
    // centered chart down instead). translateY moves only the pills.
    transform: [{ translateY: -28 }],
  },
  rangeBtn: {
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: radius.full,
  },
  rangeBtnActive: { backgroundColor: colors.card },
  rangeText: { fontSize: 15, fontWeight: '700', color: colors.sub },
  rangeTextActive: { color: colors.ink },
  futureStar: { fontSize: 11, color: colors.sub },

  actions: {
    flexDirection: 'row',
    gap: 14,
    marginTop: 36,
  },
  pill: {
    flex: 1,
    height: 58,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  pillDisabled: { opacity: 0.5 },
  pillText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  pillSecondaryText: { color: colors.ink },
});
