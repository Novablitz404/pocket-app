import * as Haptics from 'expo-haptics';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/theme';

interface Props {
  value: string; // e.g. "12.5"
  onChange: (next: string) => void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

export function AmountPad({ value, onChange }: Props) {
  const press = (key: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (key === '⌫') {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === '.') {
      if (value.includes('.')) return;
      onChange(value === '' ? '0.' : value + '.');
      return;
    }
    const next = value + key;
    const [, decimals] = next.split('.');
    if (decimals && decimals.length > 2) return;
    if (next.replace('.', '').length > 7) return;
    onChange(next === '0' ? '0' : next.replace(/^0(?=\d)/, ''));
  };

  return (
    <View style={styles.grid}>
      {KEYS.map((key) => (
        <Pressable
          key={key}
          onPress={() => press(key)}
          style={({ pressed }) => [styles.key, pressed && { backgroundColor: colors.border }]}
        >
          <Text style={styles.keyLabel}>{key}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  key: {
    width: '33.33%',
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  keyLabel: { fontSize: 26, fontWeight: '600', color: colors.ink },
});
