import { Ionicons } from '@expo/vector-icons';
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
  verified = false,
}: {
  name: string;
  uri?: string | null;
  size?: number;
  /** Small green check badge, bottom-right — mirrors the social-media
   *  "verified" convention. Ties to accountVerified (wallet-context). */
  verified?: boolean;
}) {
  const seed = name || '?';
  const badge = verified && (
    <View
      style={[
        styles.badge,
        {
          width: size * 0.32,
          height: size * 0.32,
          borderRadius: (size * 0.32) / 2,
          borderWidth: size * 0.03,
        },
      ]}
    >
      <Ionicons name="checkmark" size={size * 0.2} color="#fff" />
    </View>
  );
  if (uri) {
    return (
      <View style={{ width: size, height: size }}>
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.border }}
        />
        {badge}
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={[
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(seed) },
        ]}
      >
        <Text style={[styles.initials, { fontSize: size * 0.4 }]}>{initialsOf(seed)}</Text>
      </View>
      {badge}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontWeight: '700' },
  badge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: colors.accent,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
