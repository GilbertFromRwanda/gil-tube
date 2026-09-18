import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Palette } from '../theme/theme';

// One vertical bar per active connection (IDM-style), matching
// web/index.html's renderSegments. Each bar's fill is approximate: workers
// pull small byte-range granules off a shared queue rather than owning a
// fixed range, so an equal (bytes_total / connection count) share is used
// just to give each bar a sense of scale relative to the others.
export function SegmentBars({
  segments,
  bytesTotal,
  colors,
}: {
  segments: number[];
  bytesTotal: number | null;
  colors: Palette;
}) {
  if (segments.length < 2) return null;
  const fairShare = bytesTotal ? bytesTotal / segments.length : null;

  return (
    <View style={styles.row}>
      {segments.map((bytes, index) => {
        const percent = fairShare ? Math.min(100, (bytes / fairShare) * 100) : 0;
        return (
          <View
            key={index}
            style={[styles.bar, { backgroundColor: colors.panelAlt, borderColor: colors.border }]}
          >
            <View style={[styles.fill, { height: `${percent}%`, backgroundColor: colors.primary }]} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 28, marginTop: 6 },
  bar: {
    flex: 1,
    height: 28,
    borderRadius: 3,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  fill: { width: '100%' },
});
