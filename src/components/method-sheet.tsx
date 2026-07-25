import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '@/lib/theme';

// Method picker shown before the amount/destination screen, shared by both
// Deposit and Transfer. Bank/e-wallet rails and card funding are still
// pending partner agreements, so they're shown but disabled; the
// external-wallet USDC method is the only live one either direction today.
//
// Animated by hand (like simulate.tsx's Edit Simulation sheet): RN's Modal
// `animationType="slide"` moves the whole overlay — backdrop included — up
// with the sheet, so the dimming looks like it's sliding rather than staying
// put. Instead the backdrop fades in place while only the sheet translates.

const BANK_ICONS = [
  require('../../assets/payment providers/Bank.png'),
  require('../../assets/payment providers/gcash.jpg'),
  require('../../assets/payment providers/gotyme.png'),
  require('../../assets/payment providers/coins_ph.png'),
];
const USDC_ICON = require('../../assets/usdc.png');

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  bankSubtitle: string;
  debitSubtitle: string;
  externalSubtitle: string;
  onSelectExternalWallet: () => void;
}

export function MethodSheet({
  visible,
  onClose,
  title,
  bankSubtitle,
  debitSubtitle,
  externalSubtitle,
  onSelectExternalWallet,
}: Props) {
  const [modalVisible, setModalVisible] = useState(visible);
  const sheetAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setModalVisible(true);
      Animated.timing(sheetAnim, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    } else {
      Animated.timing(sheetAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() =>
        setModalVisible(false),
      );
    }
  }, [visible, sheetAnim]);

  return (
    <Modal visible={modalVisible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: sheetAnim }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.sheet,
            { transform: [{ translateY: sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [420, 0] }) }] },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <Ionicons name="close" size={18} color={colors.ink} />
            </Pressable>
          </View>

          <View style={[styles.row, styles.rowDisabled]}>
            <View style={styles.rowIcons}>
              {BANK_ICONS.map((src, i) => (
                <Image key={i} source={src} style={[styles.methodIcon, i > 0 && { marginLeft: -10 }]} />
              ))}
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Bank Account & E-Wallets</Text>
              <Text style={styles.rowSub}>{bankSubtitle}</Text>
            </View>
            <View style={styles.comingSoonBadge}>
              <Text style={styles.comingSoonText}>Coming soon</Text>
            </View>
          </View>

          <View style={[styles.row, styles.rowDisabled]}>
            <View style={styles.cardIconWrap}>
              <Ionicons name="card-outline" size={22} color={colors.sub} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Debit Card</Text>
              <Text style={styles.rowSub}>{debitSubtitle}</Text>
            </View>
            <View style={styles.comingSoonBadge}>
              <Text style={styles.comingSoonText}>Coming soon</Text>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
            onPress={onSelectExternalWallet}
          >
            <Image source={USDC_ICON} style={styles.methodIcon} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>External Wallet</Text>
              <Text style={styles.rowSub}>{externalSubtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.sub} />
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20,24,22,0.45)' },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: 20,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '800', color: colors.ink },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginTop: 10,
  },
  rowDisabled: { opacity: 0.55 },
  rowIcons: { flexDirection: 'row', alignItems: 'center' },
  methodIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.card,
  },
  cardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  rowSub: { fontSize: 12.5, color: colors.sub, marginTop: 2 },
  comingSoonBadge: {
    backgroundColor: colors.border,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  comingSoonText: { fontSize: 11.5, fontWeight: '700', color: colors.sub },
});
