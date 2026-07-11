import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '@/lib/theme';

// Themed single-select list, popup-style. Used by Settings for the country
// and language preferences. (Settings is a tab, not a native modal sheet, so
// a plain RN Modal floats fine on both platforms.)

export interface Option {
  value: string;
  label: string;
}

interface Props {
  visible: boolean;
  title: string;
  options: Option[];
  selected: string | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function OptionPicker({ visible, title, options, selected, onSelect, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView style={{ maxHeight: 380 }}>
            {options.map((option, i) => {
              const active = option.value === selected;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    onSelect(option.value);
                    onClose();
                  }}
                  style={({ pressed }) => [styles.option, i > 0 && styles.optionBorder, pressed && { opacity: 0.6 }]}
                >
                  <Text style={[styles.optionLabel, active && styles.optionActive]}>{option.label}</Text>
                  {active ? <Ionicons name="checkmark" size={20} color={colors.accentDark} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,24,22,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: 24,
    paddingBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '800', color: colors.ink, textAlign: 'center', marginBottom: 8 },
  option: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
  optionBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  optionLabel: { fontSize: 16, fontWeight: '600', color: colors.ink },
  optionActive: { color: colors.accentDark, fontWeight: '800' },
});
