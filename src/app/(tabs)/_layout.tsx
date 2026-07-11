import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Tabs } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { colors } from '@/lib/theme';

const BAR_HEIGHT = 62;
const NOTCH_R = 50; // half-width of the notch opening
const NOTCH_DEPTH = 38; // how deep the curve dips
const CIRCLE = 68;

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  earn: 'trending-up',
  activity: 'list',
  contacts: 'people',
  settings: 'settings-outline',
};

// Custom bar with fixed geometry: the notch path comes from the window width
// (no onLayout measuring) and every item has a constant height, so nothing
// shifts or flashes between tab switches — same pixels from the first frame.
function NotchedTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const height = BAR_HEIGHT + insets.bottom;
  const cx = width / 2;
  const d =
    `M0 0H${cx - NOTCH_R}` +
    `C${cx - NOTCH_R + 16} 0 ${cx - NOTCH_R + 6} ${NOTCH_DEPTH} ${cx} ${NOTCH_DEPTH}` +
    `C${cx + NOTCH_R - 6} ${NOTCH_DEPTH} ${cx + NOTCH_R - 16} 0 ${cx + NOTCH_R} 0` +
    `H${width}V${height}H0Z`;

  return (
    <View style={{ height }}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Path d={d} fill={colors.card} />
      </Svg>
      <View style={styles.itemsRow}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const isHome = route.name === 'home';
          const label = descriptors[route.key].options.title ?? route.name;
          const tint = focused ? colors.accentDark : colors.sub;
          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
          };
          return (
            <Pressable key={route.key} onPress={onPress} style={styles.item} hitSlop={6}>
              {isHome ? (
                <View style={styles.homeCircle}>
                  <Ionicons name="wallet" size={30} color="#fff" />
                </View>
              ) : (
                <>
                  <Ionicons name={ICONS[route.name] ?? 'ellipse'} size={24} color={tint} />
                  <Text style={[styles.label, { color: tint }]}>{label}</Text>
                </>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="home"
      tabBar={(props) => <NotchedTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // Scenes default to a white container; paint it the app background so
        // tab switches don't flash white for a frame.
        sceneStyle: { backgroundColor: colors.bg },
        // Mount every tab upfront: lazy mounting causes a one-frame layout
        // settle the first time each tab is opened.
        lazy: false,
      }}
    >
      <Tabs.Screen name="earn" options={{ title: 'Earn' }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="contacts" options={{ title: 'Contacts' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  itemsRow: { flexDirection: 'row', height: BAR_HEIGHT },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontSize: 11, fontWeight: '600' },
  homeCircle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -(CIRCLE - BAR_HEIGHT / 2 + 10),
    borderWidth: 5,
    borderColor: colors.card,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
});
