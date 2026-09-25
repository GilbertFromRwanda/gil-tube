export interface TransferSample {
  written: number;
  total: number;
  // Smoothed bytes per second.
  speed: number;
  percent: number;
}

// Turns raw "bytes written so far" callbacks into UI-ready samples: throttled
// (a fast transfer fires these many times a second, and re-rendering on every
// one would itself slow the app) and with a smoothed speed so the number
// doesn't jitter. The final sample (written >= total) is never throttled, so
// the bar always reaches 100%. Returns null when a sample should be skipped.
export function createTransferTracker(minIntervalMs = 250, now: () => number = Date.now) {
  let lastEmitAt = 0;
  let lastSampleAt = 0;
  let lastBytes = 0;
  let speed = 0;

  return function sample(written: number, total: number): TransferSample | null {
    const t = now();
    if (lastSampleAt === 0) {
      lastSampleAt = t;
      lastBytes = written;
    }

    const finished = total > 0 && written >= total;
    if (!finished && lastEmitAt !== 0 && t - lastEmitAt < minIntervalMs) return null;

    const seconds = (t - lastSampleAt) / 1000;
    if (seconds > 0) {
      const instant = Math.max(0, written - lastBytes) / seconds;
      speed = speed > 0 ? speed * 0.6 + instant * 0.4 : instant;
      lastSampleAt = t;
      lastBytes = written;
    }
    lastEmitAt = t;

    return {
      written,
      total,
      speed,
      percent: total > 0 ? Math.min(100, (written / total) * 100) : 0,
    };
  };
}
