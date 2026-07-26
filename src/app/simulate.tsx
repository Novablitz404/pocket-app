import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AmountPad } from '@/components/amount-pad';
import { usePopup } from '@/components/popup';
import { FALLBACK_APY, getCachedPoolApy, getSupplied } from '@/lib/earn-vault';
import { formatLocal } from '@/lib/fx';
import { colors, radius } from '@/lib/theme';
import { type HomeRange, setPendingHomeRange } from '@/lib/ui-state';
import { useWallet } from '@/lib/wallet-context';

// Self-contained "what if" projection: compound the pool's current rate over
// 30 years with a monthly contribution, starting from today's balance.
// Purely illustrative — the pool rate floats, so the header says "Simulated".

const YEARS_OPTIONS = [1, 2, 5, 10, 20, 30];
const MONTHLY_OPTIONS = [100, 250, 500, 1000];
const CHART_HEIGHT = 300;
const RANGES: HomeRange[] = ['1W', '1M', '1Y', 'All'];

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function formatWhole(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

interface ProjPoint {
  total: number;
  principal: number;
}

/** Bar granularity per horizon, so a short simulation still reads as a
 *  series (like Home's ranges) instead of one big block: monthly up to 2
 *  years, quarterly to 5, semi-annual to 10, yearly beyond. */
function stepMonthsFor(years: number): number {
  if (years <= 2) return 1;
  if (years <= 5) return 3;
  if (years <= 10) return 6;
  return 12;
}

/** Balances with monthly contributions compounding at `apy`, sampled every
 *  `stepMonths` months. */
function project(start: number, monthly: number, years: number, apy: number): ProjPoint[] {
  const monthlyRate = (1 + apy) ** (1 / 12) - 1;
  const step = stepMonthsFor(years);
  const points: ProjPoint[] = [];
  let total = start;
  let principal = start;
  for (let m = 1; m <= years * 12; m++) {
    total = total * (1 + monthlyRate) + monthly;
    principal += monthly;
    if (m % step === 0) points.push({ total, principal });
  }
  return points;
}

/** Axis label for the first bucket, e.g. 1M / 3M / 6M / 1Y. */
function firstTickLabel(years: number): string {
  const step = stepMonthsFor(years);
  return step === 12 ? '1Y' : `${step}M`;
}

export default function Simulate() {
  const { publicKey, localCurrency, localRate } = useWallet();
  const popup = usePopup();
  const [apy, setApy] = useState(FALLBACK_APY);
  const [start, setStart] = useState(0);
  const [monthly, setMonthly] = useState(500);
  const [years, setYears] = useState(30);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState('500'); // the sheet's in-progress amount
  const [draftYears, setDraftYears] = useState(30);
  const [padVisible, setPadVisible] = useState(false); // keypad only while editing the custom amount
  const [padHeight, setPadHeight] = useState(0); // measured natural height of the keypad
  const padAnim = React.useRef(new Animated.Value(0)).current;

  const setPad = (visible: boolean) => {
    setPadVisible(visible);
    Animated.timing(padAnim, {
      toValue: visible ? 1 : 0,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // height can't run on the native driver
    }).start();
  };
  // Animated by hand: RN's Modal slide animation moves the backdrop up with
  // the sheet, so instead the backdrop fades in place while only the sheet
  // translates.
  const sheetAnim = React.useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    try {
      const [rate, supplied] = await Promise.all([
        getCachedPoolApy(),
        publicKey ? getSupplied(publicKey) : Promise.resolve(0),
      ]);
      if (rate != null) setApy(rate);
      setStart(supplied);
    } catch {
      // fall back to defaults
    }
  }, [publicKey]);

  useEffect(() => {
    load();
  }, [load]);

  const points = useMemo(() => project(start, monthly, years, apy), [start, monthly, years, apy]);
  const final = points[points.length - 1];
  const earned = final.total - final.principal;
  const maxV = final.total || 1;

  // Gridline labels: 6 even steps from the top value down.
  const gridSteps = useMemo(
    () => Array.from({ length: 6 }, (_, i) => (maxV * (6 - i)) / 5),
    [maxV],
  );

  const onInfo = () =>
    popup.alert({
      title: 'A simulation, not a promise',
      message: `Projects your balance if the pool kept paying today's ${(apy * 100).toFixed(2)}% APY while you add ${formatWhole(monthly)} every month. The real rate floats with the pool.`,
    });

  const onPickRange = (r: HomeRange) => {
    setPendingHomeRange(r);
    router.back();
  };

  const openSheet = () => {
    setDraft(String(monthly));
    setDraftYears(years);
    setPadVisible(false);
    padAnim.setValue(0);
    setSheetOpen(true);
    Animated.timing(sheetAnim, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  };

  const closeSheet = (apply: boolean) => {
    if (apply) {
      const value = parseFloat(draft);
      if (!Number.isNaN(value) && value >= 0) setMonthly(value);
      setYears(draftYears);
    }
    Animated.timing(sheetAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() =>
      setSheetOpen(false),
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={onInfo} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="help-circle-outline" size={22} color={colors.ink} />
        </Pressable>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="close" size={22} color={colors.ink} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Pressable onPress={onInfo} style={styles.rateRow} hitSlop={6}>
          <Text style={styles.rateText}>Simulated Rate {(apy * 100).toFixed(2)}%</Text>
          <Ionicons name="information-circle-outline" size={16} color={colors.sub} />
        </Pressable>
        <Text style={styles.total}>{formatWhole(final.total)}</Text>
        {localCurrency && localRate != null && (
          <Text style={styles.totalLocal}>≈ {formatLocal(final.total, localCurrency, localRate)}</Text>
        )}
        <Text style={styles.earnedLine}>
          <Text style={styles.earnedStrong}>{formatWhole(earned)} Earned</Text> in {years} {years === 1 ? 'Year' : 'Years'}
        </Text>

        <View style={styles.chartBlock}>
          <View style={styles.chartArea}>
            {gridSteps.map((v, i) => (
              <View key={i} style={[styles.gridLine, { top: (CHART_HEIGHT * i) / 6 }]}>
                <Text style={styles.gridLabel}>{formatCompact(v)}</Text>
                <View style={styles.gridRule} />
              </View>
            ))}
            <View style={styles.barsRow}>
              {points.map((p, i) => {
                const totalH = Math.max((p.total / maxV) * CHART_HEIGHT * (5 / 6), 3);
                const principalH = Math.max((p.principal / maxV) * CHART_HEIGHT * (5 / 6), 2);
                return (
                  <View key={i} style={styles.barSlot}>
                    <View style={[styles.barTotal, { height: totalH }]} />
                    <View style={[styles.barPrincipal, { height: principalH }]} />
                  </View>
                );
              })}
            </View>
          </View>
          {/* Dotted baseline: one dot per bar, like the mock. */}
          <View style={styles.dotsRow}>
            {points.map((_, i) => (
              <View key={i} style={styles.dotSlot}>
                <View style={styles.dot} />
              </View>
            ))}
          </View>
          <View style={styles.axisRow}>
            <Text style={styles.axisLabel}>{firstTickLabel(years)}</Text>
            <Text style={styles.axisLabel}>{years}Y</Text>
          </View>
        </View>

        <View style={styles.rangeRow}>
          {RANGES.map((r) => (
            <Pressable key={r} onPress={() => onPickRange(r)} style={styles.rangeBtn}>
              <Text style={styles.rangeText}>{r}</Text>
            </Pressable>
          ))}
          <View style={[styles.rangeBtn, styles.rangeBtnActive]}>
            <Text style={[styles.rangeText, styles.rangeTextActive]}>
              Future<Text style={styles.futureStar}>+</Text>
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.simCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.simTitle}>{formatWhole(monthly)} every month</Text>
          <View style={styles.simSubRow}>
            <Ionicons name="repeat" size={13} color={colors.sub} />
            <Text style={styles.simSub}>For {years} {years === 1 ? 'year' : 'years'}</Text>
          </View>
        </View>
        <Pressable onPress={openSheet} style={styles.editBtn}>
          <Text style={styles.editBtnText}>Edit Simulation</Text>
        </Pressable>
      </View>

      {/* Edit Simulation bottom sheet. */}
      <Modal visible={sheetOpen} transparent animationType="none" onRequestClose={() => closeSheet(false)}>
        <Animated.View style={[styles.backdrop, { opacity: sheetAnim }]}>
          <Pressable style={{ flex: 1 }} onPress={() => closeSheet(false)} />
        </Animated.View>
        <View style={styles.sheetWrap} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.sheet,
              {
                transform: [
                  { translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) },
                ],
              },
            ]}
          >
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Monthly deposit</Text>
            <View style={styles.chipRow}>
              {MONTHLY_OPTIONS.map((m) => (
                <Pressable
                  key={m}
                  onPress={() => {
                    setDraft(String(m));
                    if (padVisible) setPad(false);
                  }}
                  style={[styles.chip, parseFloat(draft) === m && styles.chipActive]}
                >
                  <Text style={[styles.chipText, parseFloat(draft) === m && styles.chipTextActive]}>
                    ${m}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={() => setPad(!padVisible)}
              style={[styles.inputRow, padVisible && styles.inputRowActive]}
            >
              <Text style={styles.inputPrefix}>$</Text>
              <Text style={[styles.inputValue, !draft && { color: colors.sub }]}>
                {draft || '0'}
              </Text>
              <Text style={styles.inputSuffix}>/ month</Text>
            </Pressable>
            <Text style={[styles.sheetTitle, { marginTop: 18 }]}>For</Text>
            <View style={styles.chipRow}>
              {YEARS_OPTIONS.map((y) => (
                <Pressable
                  key={y}
                  onPress={() => setDraftYears(y)}
                  style={[styles.chip, styles.yearChip, draftYears === y && styles.chipActive]}
                >
                  <Text style={[styles.chipText, styles.yearChipText, draftYears === y && styles.chipTextActive]}>
                    {y}{y === 1 ? 'yr' : 'yrs'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Animated.View
              style={{
                height: padHeight ? padAnim.interpolate({ inputRange: [0, 1], outputRange: [0, padHeight] }) : 0,
                opacity: padAnim,
                overflow: 'hidden',
              }}
              pointerEvents={padVisible ? 'auto' : 'none'}
            >
              <View style={styles.padWrap}>
                <AmountPad value={draft} onChange={setDraft} />
              </View>
            </Animated.View>
            {/* Hidden full-size copy, measured once to drive the height above
                (measuring inside the collapsed container reports 0). */}
            {padHeight === 0 && (
              <View
                style={styles.padMeasure}
                pointerEvents="none"
                onLayout={(e) => {
                  const h = e.nativeEvent.layout.height;
                  if (h > 0) setPadHeight(h);
                }}
              >
                <View style={styles.padWrap}>
                  <AmountPad value={draft} onChange={setDraft} />
                </View>
              </View>
            )}
            <Pressable onPress={() => closeSheet(true)} style={styles.doneBtn}>
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </Animated.View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 10,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },

  body: { flex: 1, paddingHorizontal: 24 },

  rateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 26,
  },
  rateText: { fontSize: 17, fontWeight: '600', color: colors.sub },
  total: {
    fontSize: 60,
    fontWeight: '800',
    color: colors.accentDark,
    textAlign: 'center',
    marginTop: 10,
    letterSpacing: -1.5,
  },
  totalLocal: { textAlign: 'center', color: colors.sub, fontSize: 18, fontWeight: '600', marginTop: 2 },
  earnedLine: { textAlign: 'center', color: colors.sub, fontSize: 17, marginTop: 10 },
  earnedStrong: { color: colors.ink, fontWeight: '800' },

  chartBlock: { flex: 1, justifyContent: 'center' },
  chartArea: { height: CHART_HEIGHT },
  gridLine: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  gridLabel: { width: 44, fontSize: 12, color: colors.sub, textAlign: 'right' },
  gridRule: { flex: 1, borderBottomWidth: 1, borderStyle: 'dashed', borderColor: colors.border },
  barsRow: {
    position: 'absolute',
    left: 56,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
  },
  barSlot: { flex: 1, justifyContent: 'flex-end' },
  barTotal: {
    backgroundColor: 'rgba(0, 168, 98, 0.18)',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  barPrincipal: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.accent,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    opacity: 0.9,
  },
  dotsRow: { flexDirection: 'row', paddingLeft: 56, gap: 3, marginTop: 8 },
  dotSlot: { flex: 1, alignItems: 'center' },
  dot: { width: 3.5, height: 3.5, borderRadius: 2, backgroundColor: colors.border },
  axisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingLeft: 56,
  },
  axisLabel: { fontSize: 13, color: colors.sub },

  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
    marginBottom: 24,
  },
  rangeBtn: { paddingHorizontal: 15, paddingVertical: 9, borderRadius: radius.full },
  rangeBtnActive: { backgroundColor: colors.card },
  rangeText: { fontSize: 15, fontWeight: '700', color: colors.sub },
  rangeTextActive: { color: colors.ink },
  futureStar: { fontSize: 11, color: colors.sub },

  simCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginHorizontal: 24,
    marginBottom: 8,
  },
  simTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  simSubRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  simSub: { color: colors.sub, fontSize: 13, fontWeight: '600' },
  editBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.full,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  editBtnText: { color: colors.accentDark, fontSize: 14, fontWeight: '700' },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 27, 20, 0.4)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 36,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 16,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: colors.ink, marginBottom: 14 },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
  },
  chipActive: { backgroundColor: colors.accent },
  chipText: { color: colors.accentDark, fontSize: 14, fontWeight: '700' },
  chipTextActive: { color: '#fff' },
  // Six year chips share the row, so they run tighter than the money presets.
  yearChip: { paddingVertical: 10, paddingHorizontal: 0 },
  yearChipText: { fontSize: 13 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 16,
    height: 54,
  },
  inputPrefix: { fontSize: 17, fontWeight: '700', color: colors.ink, marginRight: 4 },
  inputValue: { flex: 1, fontSize: 17, color: colors.ink, fontWeight: '700' },
  inputRowActive: { borderColor: colors.accent },
  inputSuffix: { fontSize: 14, color: colors.sub, fontWeight: '600' },
  padWrap: { marginTop: 6 },
  // Off-screen measuring copy: laid out at natural size but not visible.
  padMeasure: { position: 'absolute', left: 0, right: 0, opacity: 0 },
  doneBtn: {
    marginTop: 16,
    height: 54,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
