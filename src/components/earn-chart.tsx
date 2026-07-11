import React, { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg';
import { colors, radius } from '@/lib/theme';

export interface ChartPoint {
  t: number; // ms epoch
  v: number; // dollars
  apy?: number | null; // the pool's live rate at this point, if known
}

const HEIGHT = 140;
const PADDING_TOP = 16; // room for the touch callout above the line
const PADDING_BOTTOM = 20; // room for the min gridline label

function formatChartValue(v: number): string {
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function formatDay(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Single-series growth line for Earn: 2px accent line, ~10% area wash, one
 * end-dot, two gridlines (min/max), and a drag-to-scrub crosshair + tooltip —
 * the touch equivalent of a hover layer. No legend: one color needs none.
 */
export function EarnChart({ points }: { points: ChartPoint[] }) {
  const [width, setWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { linePath, areaPath, scaleX, scaleY, minV, maxV } = useMemo(() => {
    if (width === 0 || points.length < 2) {
      return { linePath: '', areaPath: '', scaleX: (_: number) => 0, scaleY: (_: number) => 0, minV: 0, maxV: 0 };
    }
    const minT = points[0].t;
    const maxT = points[points.length - 1].t;
    const values = points.map((p) => p.v);
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values) * 1.15 || 1;
    const plotH = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
    const sx = (t: number) => (maxT === minT ? width / 2 : ((t - minT) / (maxT - minT)) * width);
    const sy = (v: number) => PADDING_TOP + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;
    const coords = points.map((p) => [sx(p.t), sy(p.v)] as const);
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const baseline = sy(minV);
    const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${baseline} L${coords[0][0].toFixed(1)},${baseline} Z`;
    return { linePath: line, areaPath: area, scaleX: sx, scaleY: sy, minV, maxV };
  }, [points, width]);

  const nearestIndex = (x: number) => {
    if (points.length === 0) return 0;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(scaleX(points[i].t) - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => setActiveIndex(nearestIndex(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setActiveIndex(nearestIndex(e.nativeEvent.locationX)),
        onPanResponderRelease: () => setActiveIndex(null),
        onPanResponderTerminate: () => setActiveIndex(null),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, width],
  );

  if (points.length < 2) return null;

  const active = activeIndex !== null ? points[activeIndex] : null;
  const activeX = active ? scaleX(active.t) : 0;
  const activeY = active ? scaleY(active.v) : 0;
  const calloutWidth = active?.apy != null ? 118 : 96;
  const calloutLeft = Math.min(Math.max(activeX - calloutWidth / 2, 0), Math.max(width - calloutWidth, 0));

  return (
    <View style={styles.wrap}>
      <View
        style={{ height: HEIGHT }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...panResponder.panHandlers}
      >
        {width > 0 && (
          <Svg width={width} height={HEIGHT}>
            <Defs>
              <LinearGradient id="earnFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.accent} stopOpacity={0.1} />
                <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {/* Gridlines: max at top of plot, min at the baseline — hairline, recessive. */}
            <Line x1={0} y1={PADDING_TOP} x2={width} y2={PADDING_TOP} stroke={colors.border} strokeWidth={1} />
            <Line
              x1={0}
              y1={HEIGHT - PADDING_BOTTOM}
              x2={width}
              y2={HEIGHT - PADDING_BOTTOM}
              stroke={colors.border}
              strokeWidth={1}
            />
            <Path d={areaPath} fill="url(#earnFill)" />
            <Path d={linePath} stroke={colors.accent} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {/* End-dot: ring in the surface color so it stays legible against the line. */}
            <Circle cx={scaleX(points[points.length - 1].t)} cy={scaleY(points[points.length - 1].v)} r={6} fill={colors.card} />
            <Circle cx={scaleX(points[points.length - 1].t)} cy={scaleY(points[points.length - 1].v)} r={4} fill={colors.accent} />
            {active && (
              <>
                <Line x1={activeX} y1={PADDING_TOP} x2={activeX} y2={HEIGHT - PADDING_BOTTOM} stroke={colors.sub} strokeWidth={1} />
                <Circle cx={activeX} cy={activeY} r={6} fill={colors.card} />
                <Circle cx={activeX} cy={activeY} r={4} fill={colors.accent} />
              </>
            )}
          </Svg>
        )}
        {active && (
          <View style={[styles.callout, { left: calloutLeft, width: calloutWidth }]} pointerEvents="none">
            <Text style={styles.calloutValue}>{formatChartValue(active.v)}</Text>
            <Text style={styles.calloutDate}>
              {formatDay(active.t)}
              {active.apy != null ? ` · ${(active.apy * 100).toFixed(2)}% APY` : ''}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.axisRow}>
        <Text style={styles.axisLabel}>{formatDay(points[0].t)}</Text>
        <Text style={styles.axisValue}>{formatChartValue(maxV / 1.15)}</Text>
        <Text style={styles.axisLabel}>{formatDay(points[points.length - 1].t)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 4 },
  callout: {
    position: 'absolute',
    top: 0,
    backgroundColor: colors.ink,
    borderRadius: radius.sm,
    paddingVertical: 4,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  calloutValue: { color: '#fff', fontSize: 12, fontWeight: '800' },
  calloutDate: { color: '#C7D3CB', fontSize: 10, marginTop: 1 },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  axisLabel: { fontSize: 11, color: colors.sub },
  axisValue: { fontSize: 11, color: colors.sub, fontWeight: '600' },
});
