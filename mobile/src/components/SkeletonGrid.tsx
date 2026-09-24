import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Palette } from '../theme/theme';

// Placeholder cards shown while a search is in flight. Rows of two with the
// same margins as ResultCard, so the grid doesn't jump when results land.
export function SkeletonGrid({ colors, rows = 4 }: { colors: Palette; rows?: number }) {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.grid} accessibilityLabel="Loading results" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={styles.row}>
          {[0, 1].map((col) => (
            <View
              key={col}
              style={[styles.card, { backgroundColor: colors.panel, borderColor: colors.border }]}
            >
              <Animated.View style={{ opacity: pulse }}>
                <View style={[styles.thumb, { backgroundColor: colors.panelAlt }]} />
                <View style={styles.info}>
                  <View style={[styles.line, { backgroundColor: colors.panelAlt }]} />
                  <View style={[styles.line, styles.short, { backgroundColor: colors.panelAlt }]} />
                </View>
              </Animated.View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { paddingHorizontal: 6 },
  row: { flexDirection: 'row' },
  card: { flex: 1, margin: 6, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  thumb: { width: '100%', aspectRatio: 16 / 9 },
  info: { padding: 8 },
  line: { height: 10, borderRadius: 5, marginBottom: 7 },
  short: { width: '55%', marginBottom: 0 },
});
