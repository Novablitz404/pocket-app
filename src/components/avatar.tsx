import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/theme';

// Profile picture when one is set; otherwise deterministic initials-on-a-color.
const PALETTE = ['#00A862', '#2D7FF9', '#F5A623', '#E0518C', '#7B61FF', '#12B5B0', '#E8663D'];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function Avatar({
  name,
  uri,
  size = 44,
}: {
  name: string;
  uri?: string | null;
  size?: number;
}) {
  const seed = name || '?';
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.border }}
      />
    );
  }
  return (
    <View
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(seed) },
      ]}
    >
      <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initialsOf(seed)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontWeight: '700' },
});
