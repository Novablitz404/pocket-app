import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { type ChartPoint, EarnChart } from '@/components/earn-chart';
import { usePopup } from '@/components/popup';
import { Skeleton } from '@/components/skeleton';
import { ensureUnlocked } from '@/lib/biometrics';
import { FALLBACK_APY, WITHDRAW_FEE_RATE, getEarnState } from '@/lib/earn-blend';
import { getNetDeposited, getPoolRates, getSnapshots, maybeRecordSnapshot, type PoolRate } from '@/lib/earn-ledger';
import { colors, formatUsd, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

/** Dollar format with enough precision for small accruals (e.g. $0.0031). */
function formatEarnings(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return formatUsd(amount);
}

/** The pool-rate history is its own timeline (written independently by
 *  scripts/record-pool-rate.mjs), so a user's balance snapshot rarely lands
 *  on the exact same instant as a rate row — find whichever rate point is
 *  closest in time instead of requiring an exact match. */
function nearestApy(rates: PoolRate[], t: number): number | null {
  if (rates.length === 0) return null;
  let best = rates[0];
  let bestDist = Math.abs(new Date(best.createdAt).getTime() - t);
  for (const r of rates) {
    const d = Math.abs(new Date(r.createdAt).getTime() - t);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  return best.apy;
}

export default function Earn() {
  const { balance, publicKey, activated, earnDeposit, earnWithdraw } = useWallet();
  const popup = usePopup();
  const insets = useSafeAreaInsets();
  const [supplied, setSupplied] = useState(0);
  const [apy, setApy] = useState(FALLBACK_APY);
  const [netDeposited, setNetDeposited] = useState<number | null>(null);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const [loadingState, setLoadingState] = useState(true);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!publicKey || !activated) {
      setLoadingState(false);
      return;
    }
    try {
      const [s, net] = await Promise.all([getEarnState(publicKey), getNetDeposited(publicKey)]);
      setSupplied(s.supplied);
      setApy(s.apy);
      setNetDeposited(net);
      // Fire-and-forget: log today's point (own balance, per-user), then load
      // this user's history plus the pool's rate history (written separately
      // by scripts/record-pool-rate.mjs — see nearestApy above) to annotate
      // the chart tooltip with what the rate actually was at each point.
      maybeRecordSnapshot(publicKey, s.supplied, net ?? 0).catch(() => {});
      Promise.all([getSnapshots(publicKey), getPoolRates()])
        .then(([snaps, rates]) =>
          setChartPoints(
            snaps.map((snap) => {
              const t = new Date(snap.createdAt).getTime();
              return { t, v: snap.earned, apy: nearestApy(rates, t) };
            }),
          ),
        )
        .catch(() => {});
    } catch {
      // leave last-known values
    } finally {
      setLoadingState(false);
    }
  }, [publicKey, activated]);

  useFocusEffect(
    useCallback(() => {
      setLoadingState(true);
      load();
    }, [load]),
  );

  const onDeposit = async () => {
    const value = parseFloat(amount);
    if (!value || value <= 0) return;
    if (value > balance) {
      popup.alert({
        title: 'Not enough balance',
        message: `You can move up to ${formatUsd(balance)} into Earn.`,
      });
      return;
    }
    if (!(await ensureUnlocked(`Move ${formatUsd(value)} into Earn`))) return;
    setBusy(true);
    try {
      await earnDeposit(value);
      setAmount('');
      await load();
      popup.alert({ title: 'Now earning', message: `${formatUsd(value)} is earning yield in Blend.` });
    } catch (e: any) {
      popup.alert({ title: 'Deposit failed', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const onWithdraw = async () => {
    const estimatedFee = supplied * WITHDRAW_FEE_RATE;
    const ok = await popup.confirm({
      title: 'Withdraw everything?',
      message: 'Your Earn balance returns to your account instantly.',
      rows: [
        { label: 'Withdraw', value: formatUsd(supplied) },
        { label: `Fee (${(WITHDRAW_FEE_RATE * 100).toFixed(1)}%)`, value: `-${formatUsd(estimatedFee)}` },
        { label: 'You receive', value: formatUsd(supplied - estimatedFee), emphasize: true },
      ],
      confirmText: 'Withdraw',
    });
    if (!ok) return;
    if (!(await ensureUnlocked('Withdraw from Earn'))) return;

    setBusy(true);
    try {
      const { withdrawn, fee } = await earnWithdraw();
      await load();
      await popup.alert({
        title: 'Withdrawn',
        message: `${formatUsd(withdrawn - fee)} returned to your balance.`,
      });
    } catch (e: any) {
      popup.alert({ title: 'Withdrawal failed', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  // Interest is the only thing that changes a Blend position's value, so
  // earnings are exactly the on-chain balance minus the recorded principal.
  const earned =
    netDeposited !== null && supplied > 0 ? Math.max(0, supplied - netDeposited) : null;
  const perDay = supplied * apy / 365;

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Earn</Text>

        <View style={styles.card}>
          <View style={styles.apyBadge}>
            <Text style={styles.apyText}>{(apy * 100).toFixed(1)}% APY</Text>
          </View>
          <Text style={styles.cardLabel}>Earning balance</Text>
          {loadingState ? (
            <>
              <Skeleton width={160} height={40} radius={10} color="rgba(0,0,0,0.08)" style={{ marginTop: 6 }} />
              <Skeleton width={220} height={14} radius={7} color="rgba(0,0,0,0.08)" style={{ marginTop: 10 }} />
            </>
          ) : (
            <>
              <View style={styles.balanceRow}>
                <Text style={styles.cardBalance}>{formatUsd(supplied)}</Text>
                {earned !== null && (
                  <Text style={styles.pnlText}>+{formatEarnings(earned)}</Text>
                )}
              </View>
              {supplied > 0.0000001 && (
                <Text style={styles.earnedRow}>
                  At today's rate: ~{formatEarnings(perDay)}/day ({(apy * 100).toFixed(1)}% APY)
                </Text>
              )}
            </>
          )}
        </View>

        {chartPoints.length >= 2 ? (
          <View style={styles.chartCard}>
            <Text style={styles.chartTitle}>Your growth</Text>
            <EarnChart points={chartPoints} />
          </View>
        ) : (
          supplied > 0.0000001 && (
            <Text style={styles.chartHint}>Check back tomorrow to see your growth chart.</Text>
          )
        )}

        <Text style={styles.sectionTitle}>Move money into Earn</Text>
        <Text style={styles.hint}>Available: {formatUsd(balance)}</Text>
        <TextInput
          style={styles.input}
          placeholder="Amount in USD"
          placeholderTextColor={colors.sub}
          keyboardType="decimal-pad"
          value={amount}
          onChangeText={setAmount}
        />
        <Button
          title="Start earning"
          onPress={onDeposit}
          loading={busy}
          disabled={!parseFloat(amount)}
          style={{ marginTop: 12 }}
        />
        {supplied > 0.0000001 && (
          <Button
            title="Withdraw everything"
            variant="secondary"
            onPress={onWithdraw}
            loading={busy}
            style={{ marginTop: 10 }}
          />
        )}
        <View style={styles.poweredBy}>
          <Text style={styles.poweredByText}>Powered by</Text>
          <Image
            source={require('@/assets/images/blend logo.png')}
            style={styles.poweredByLogo}
            resizeMode="contain"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 20, paddingBottom: 40 },
  title: { fontSize: 28, fontWeight: '800', color: colors.ink, marginBottom: 12 },
  card: { backgroundColor: colors.goldSoft, borderRadius: radius.lg, padding: 24, minHeight: 150 },
  apyBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.gold,
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 14,
  },
  apyText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  cardLabel: { color: colors.sub, fontSize: 14, fontWeight: '600' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  cardBalance: { color: colors.ink, fontSize: 38, fontWeight: '800' },
  pnlText: { color: colors.accentDark, fontSize: 15, fontWeight: '800' },
  earnedRow: { color: colors.sub, fontSize: 14, fontWeight: '600', marginTop: 6 },
  chartCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    marginTop: 16,
  },
  chartTitle: { fontSize: 15, fontWeight: '700', color: colors.ink, marginBottom: 4 },
  chartHint: { color: colors.sub, fontSize: 13, marginTop: 16, textAlign: 'center' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 28 },
  hint: { color: colors.sub, fontSize: 14, marginTop: 4, marginBottom: 10 },
  input: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    fontSize: 17,
    color: colors.ink,
  },
  poweredBy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    marginTop: 28,
  },
  poweredByText: { color: colors.sub, fontSize: 13, fontWeight: '600' },
  // The wordmark is ~3.5:1; keep it modest so it reads as a credit line.
  poweredByLogo: { width: 70, height: 20 },
});
