import React, { useEffect, useRef } from 'react';
import { Animated, DimensionValue, StyleSheet, ViewStyle } from 'react-native';

interface Props {
  width: DimensionValue;
  height: number;
  radius?: number;
  color?: string;
  style?: ViewStyle;
}

/** A pulsing placeholder block for loading states. */
export function Skeleton({ width, height, radius = 8, color = 'rgba(255,255,255,0.18)', style }: Props) {
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.9, duration: 750, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[styles.base, { width, height, borderRadius: radius, backgroundColor: color, opacity }, style]}
    />
  );
}

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
});
