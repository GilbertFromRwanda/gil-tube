import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Palette } from '../theme/theme';

export function ProgressBar({
  percent,
  colors,
  indeterminate = false,
}: {
  percent: number;
  colors: Palette;
  indeterminate?: boolean;
}) {
  return (
    <View style={[styles.track, { backgroundColor: colors.panelAlt, borderColor: colors.border }]}>
      <View
        style={[
          styles.fill,
          {
            backgroundColor: colors.primary,
            width: indeterminate ? '35%' : `${Math.min(100, Math.max(0, percent))}%`,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 10,
    borderRadius: 6,
    borderWidth: 1,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 6,
  },
});
