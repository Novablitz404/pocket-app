import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { colors, radius } from '@/lib/theme';

// ── Data shaping ────────────────────────────────────────────────────────────

export interface SnapshotPoint {
  t: number; // ms epoch
  v: number; // savings balance (supplied) at that time
  net: number; // principal recorded in the earn ledger at that time
}

export interface BarDatum {
  t: number; // bucket end (ms epoch)
  v: number; // balance at bucket end
  added: number; // principal moved in during the bucket
  withdrew: number; // principal moved out during the bucket
  earned: number; // interest accrued during the bucket
}

/**
 * Reduce a snapshot series to `buckets` bars spanning [startT, endT]. Each
 * bar carries the last known balance (carried forward through empty buckets,
 * so the shape reads as a balance) plus what happened inside the bucket:
 * principal in/out comes from the net-deposited deltas, and whatever balance
 * change those deltas don't explain is interest earned.
 */
export function bucketize(
  points: SnapshotPoint[],
  buckets: number,
  startT: number,
  endT: number,
): BarDatum[] {
  if (points.length === 0) return [];
  const span = Math.max(endT - startT, 1);
  let i = 0;
  let lastV = 0;
  let lastNet = 0;
  // Points before the window seed the carry-forward values.
  while (i < points.length && points[i].t < startT) {
    lastV = points[i].v;
    lastNet = points[i].net;
    i++;
  }
  const bars: BarDatum[] = [];
  for (let b = 0; b < buckets; b++) {
    const end = startT + (span * (b + 1)) / buckets;
    const prevV = lastV;
    const prevNet = lastNet;
    let added = 0;
    let withdrew = 0;
    while (i < points.length && points[i].t <= end) {
      const dNet = points[i].net - lastNet;
      if (dNet > 0.005) added += dNet;
      else if (dNet < -0.005) withdrew += -dNet;
      lastV = points[i].v;
      lastNet = points[i].net;
      i++;
    }
    const earned = Math.max(0, lastV - prevV - (lastNet - prevNet));
    bars.push({ t: end, v: lastV, added, withdrew, earned });
  }
  return bars;
}

// ── Chart ───────────────────────────────────────────────────────────────────

const BAR_AREA = 300; // bars baseline-aligned inside this height
const TOP_PAD = 84; // headroom so the tooltip fits above the tallest bar
const GAP = 14; // gap between bars
const CHIP = 26; // event-marker circle diameter
const LABEL_H = 30; // reserved strip under the baseline for the date label
const MIN_BAR = 8;
// Rough first-paint guess before the pill measures its own content (it now
// sizes to its label+value, see tipW below) — just needs to be in the
// ballpark so there's no visible jump once the real width lands.
const TOOLTIP_W_ESTIMATE = 120;

function formatMoney(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDay(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Mini "coin" for added-money events: accent circle with a white $. */
function CoinIcon({ size = 16 }: { size?: number }) {
  return (
    <View style={[styles.miniIcon, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.accent }]}>
      <Text style={[styles.miniIconText, { fontSize: size * 0.62 }]}>$</Text>
    </View>
  );
}

/** Mini marker for withdrawals: gray circle with a white up arrow. */
function ArrowIcon({ size = 16 }: { size?: number }) {
  return (
    <View style={[styles.miniIcon, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.sub }]}>
      <Text style={[styles.miniIconText, { fontSize: size * 0.62 }]}>↑</Text>
    </View>
  );
}

/**
 * The mock's savings chart: baseline-aligned gradient pill bars, event chips
 * (money in / out) riding the bottom of their bar, and a tap-to-pin selection
 * that shows a tooltip of the bucket's events above the bar and its date
 * below the baseline.
 */
export function SavingsChart({
  bars,
  selected,
  onSelect,
}: {
  bars: BarDatum[];
  selected: number | null;
  onSelect: (index: number | null) => void;
}) {
  const [width, setWidth] = useState(0);
  // The tooltip sizes itself to its content (no fixed width), so its actual
  // on-screen width is only known after it lays out. tipW starts at a rough
  // estimate for the very first paint, then onLayout below corrects it — and
  // resets per-selection so a wider/narrower bar's tooltip doesn't inherit the
  // previous one's measured width before re-measuring.
  const [tipW, setTipW] = useState(TOOLTIP_W_ESTIMATE);
  useEffect(() => {
    setTipW(TOOLTIP_W_ESTIMATE);
  }, [selected]);

  const maxV = useMemo(() => Math.max(...bars.map((b) => b.v), 0.01), [bars]);

  if (bars.length < 2 || bars.every((b) => b.v <= 0 && !b.added && !b.withdrew)) {
    return (
      <View style={[styles.wrap, styles.emptyWrap]}>
        <Text style={styles.empty}>Your growth chart appears after a day of saving.</Text>
      </View>
    );
  }

  const n = bars.length;
  const slotW = width > 0 ? width / n : 0;
  const barW = Math.max(slotW - GAP, 4);
  const geometry = bars.map((bar, i) => {
    const h = Math.max((bar.v / maxV) * (BAR_AREA - TOP_PAD), MIN_BAR);
    return {
      x: i * slotW + GAP / 2,
      y: BAR_AREA - h,
      w: barW,
      h,
      cx: i * slotW + slotW / 2,
    };
  });

  const sel = selected !== null && selected < n ? selected : null;
  const selBar = sel !== null ? bars[sel] : null;
  const selGeo = sel !== null ? geometry[sel] : null;

  // Tooltip: above the selected bar, clamped inside the chart. Two possible
  // rows (added / withdrew); falls back to the balance when the bucket had
  // no money movement.
  const tooltipRows: { icon: 'coin' | 'arrow'; label: string; value: string }[] = [];
  if (selBar) {
    if (selBar.added > 0.005) tooltipRows.push({ icon: 'coin', label: 'Added', value: formatMoney(selBar.added) });
    if (selBar.withdrew > 0.005) tooltipRows.push({ icon: 'arrow', label: 'Withdrew', value: formatMoney(selBar.withdrew) });
    if (tooltipRows.length === 0) tooltipRows.push({ icon: 'coin', label: 'Balance', value: formatMoney(selBar.v) });
  }
  const tooltipH = 16 + tooltipRows.length * 26;
  const tooltipLeft = selGeo
    ? Math.min(Math.max(selGeo.cx - tipW / 2, 0), Math.max(width - tipW, 0))
    : 0;
  const tooltipTop = selGeo ? Math.max(selGeo.y - tooltipH - 12, 0) : 0;

  return (
    <View style={styles.wrap} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={BAR_AREA}>
          <Defs>
            <LinearGradient id="barIdle" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.accent} stopOpacity={0.16} />
              <Stop offset="1" stopColor={colors.accent} stopOpacity={0.05} />
            </LinearGradient>
            <LinearGradient id="barActive" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.accent} stopOpacity={1} />
              <Stop offset="1" stopColor={colors.accent} stopOpacity={0.6} />
            </LinearGradient>
          </Defs>
          {geometry.map((g, i) => (
            <Rect
              key={i}
              x={g.x}
              y={g.y}
              width={g.w}
              height={g.h}
              rx={Math.min(g.w * 0.42, g.h / 2)}
              fill={i === sel ? 'url(#barActive)' : 'url(#barIdle)'}
            />
          ))}
        </Svg>
      )}

      {/* Event chips riding the bottom edge of their bar. */}
      {width > 0 &&
        bars.map((bar, i) => {
          const hasAdd = bar.added > 0.005;
          const hasOut = bar.withdrew > 0.005;
          if (!hasAdd && !hasOut) return null;
          const both = hasAdd && hasOut;
          const chipW = both ? CHIP + 12 : CHIP;
          return (
            <View
              key={`chip-${i}`}
              pointerEvents="none"
              style={[
                styles.chip,
                {
                  width: chipW,
                  left: geometry[i].cx - chipW / 2,
                  top: BAR_AREA - CHIP + 6,
                },
              ]}
            >
              {hasAdd && <CoinIcon />}
              {hasOut && <ArrowIcon />}
            </View>
          );
        })}

      {/* Date under the selected bar. */}
      {selGeo && selBar && (
        <Text
          style={[styles.dateLabel, { left: selGeo.cx - 60, top: BAR_AREA + 10 }]}
          pointerEvents="none"
        >
          {formatDay(selBar.t)}
        </Text>
      )}

      {/* Tooltip above the selected bar. Sizes itself to its content (no fixed
          width) so the pill stays proportional to the label + value instead
          of a one-size guess; onLayout feeds the real width back into the
          centering math above. */}
      {selGeo && (
        <View
          style={[styles.tooltip, { left: tooltipLeft, top: tooltipTop }]}
          pointerEvents="none"
          onLayout={(e) => setTipW(e.nativeEvent.layout.width)}
        >
          {tooltipRows.map((row, i) => (
            <View key={i} style={styles.tooltipRow}>
              <Text style={styles.tooltipLabel} numberOfLines={1}>{row.label}</Text>
              <Text style={styles.tooltipValue} numberOfLines={1}>{row.value}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Tap layer: one slot per bar, toggles the pinned selection. */}
      <View style={styles.touchRow} pointerEvents="box-none">
        {bars.map((_, i) => (
          <Pressable
            key={i}
            style={{ flex: 1 }}
            onPress={() => onSelect(sel === i ? null : i)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: BAR_AREA + LABEL_H },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  empty: { color: colors.sub, fontSize: 14, textAlign: 'center' },

  touchRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: BAR_AREA,
    flexDirection: 'row',
  },

  chip: {
    position: 'absolute',
    height: CHIP,
    borderRadius: CHIP / 2,
    backgroundColor: colors.card,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  miniIcon: { alignItems: 'center', justifyContent: 'center' },
  miniIconText: { color: '#fff', fontWeight: '800' },

  dateLabel: {
    position: 'absolute',
    width: 120,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '700',
    color: colors.accentDark,
  },

  tooltip: {
    position: 'absolute',
    alignItems: 'flex-start', // size to content width, don't stretch rows
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  tooltipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 22,
  },
  tooltipLabel: { fontSize: 14, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  tooltipValue: { fontSize: 14, fontWeight: '600', color: colors.sub, flexShrink: 0 },
});
