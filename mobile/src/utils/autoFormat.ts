import type { FormatEntry } from '../api/types';

// "Auto" download quality: pick the best resolution the current connection can
// comfortably fetch, instead of always the biggest file. Pure logic (no React,
// no network) so it is unit-tested: `npm run test:auto`. The web UI has the same
// rules in web/index.html (block "Auto quality"); keep them in step.

// The Picker value that means "choose for me".
export const AUTO_FORMAT = '__auto__';

// A format is chosen only if fetching it takes at most this share of the
// connection's speed measured over the length of the video - i.e. it would
// arrive at about twice real time or better. Leaves room for the network being
// slower than the short test suggested.
export const SPEED_HEADROOM = 0.5;

// Rough bitrate of a YouTube video track by height, in Mbit/s, used when the
// exact file size isn't known.
const TYPICAL_VIDEO_MBPS: Array<[number, number]> = [
  [144, 0.3],
  [240, 0.6],
  [360, 1],
  [480, 1.8],
  [720, 3.5],
  [1080, 6.5],
  [1440, 13],
  [2160, 30],
];
const AUDIO_MBPS = 0.13; // the audio track that gets merged in

function typicalVideoMbps(height: number): number {
  let mbps = TYPICAL_VIDEO_MBPS[0][1];
  for (const [h, rate] of TYPICAL_VIDEO_MBPS) {
    if (height >= h) mbps = rate;
  }
  return mbps;
}

function hasAudio(format: FormatEntry): boolean {
  return !!format.audio_codec && format.audio_codec !== 'none';
}

// Mbit/s needed to fetch this format over the video's length.
export function estimateMbps(format: FormatEntry, durationSeconds: number | null | undefined): number {
  const audioExtra = hasAudio(format) ? 0 : AUDIO_MBPS;
  if (format.filesize && format.filesize > 0 && durationSeconds && durationSeconds > 0) {
    return (format.filesize * 8) / durationSeconds / 1e6 + audioExtra;
  }
  return typicalVideoMbps(format.height || 0) + audioExtra;
}

export interface AutoPick {
  format: FormatEntry;
  estimatedMbps: number;
  budgetMbps: number;
}

// One format per resolution: prefer mp4 (plays everywhere), then the larger file.
function bestOfHeight(candidates: FormatEntry[]): FormatEntry {
  return candidates.reduce((best, f) => {
    const bestMp4 = best.container === 'mp4';
    const fMp4 = f.container === 'mp4';
    if (fMp4 !== bestMp4) return fMp4 ? f : best;
    return (f.filesize || 0) > (best.filesize || 0) ? f : best;
  });
}

// The best video format that fits `mbps` (measured connection speed), or the
// smallest one if nothing does. null when the speed is unknown or there is no
// video format to choose from - the caller then falls back to "best available".
export function chooseFormat(
  formats: FormatEntry[],
  mbps: number | null | undefined,
  durationSeconds: number | null | undefined,
): AutoPick | null {
  if (!mbps || !Number.isFinite(mbps) || mbps <= 0) return null;

  const byHeight = new Map<number, FormatEntry[]>();
  for (const f of formats) {
    if (!f.id || !f.height || f.height <= 0) continue; // audio-only entries
    const list = byHeight.get(f.height) ?? [];
    list.push(f);
    byHeight.set(f.height, list);
  }
  if (byHeight.size === 0) return null;

  const budgetMbps = mbps * SPEED_HEADROOM;
  const heights = [...byHeight.keys()].sort((a, b) => a - b);

  // Start from the smallest (used if nothing fits), then take the highest that
  // does. Every height is checked: with real file sizes a higher resolution can
  // occasionally be the smaller download.
  let chosen: AutoPick | null = null;
  for (const h of heights) {
    const format = bestOfHeight(byHeight.get(h)!);
    const estimatedMbps = estimateMbps(format, durationSeconds);
    if (chosen === null || estimatedMbps <= budgetMbps) {
      chosen = { format, estimatedMbps, budgetMbps };
    }
  }
  return chosen;
}

export function formatMbps(mbps: number): string {
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`;
  return `${mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
}

// Turns a byte count and elapsed time into Mbit/s (null if either is unusable).
export function mbpsFrom(bytes: number, ms: number): number | null {
  if (!(bytes > 0) || !(ms > 0)) return null;
  return Math.min((bytes * 8) / (ms * 1000), 1000);
}

export interface SpeedSample {
  bytes: number;
  ms: number;
}

// Measures connection speed on demand, remembers the answer for a while (a
// speed test on every click would be wasteful and slow), and shares one test
// between callers that ask at the same time.
export function createSpeedMeter(
  measure: () => Promise<SpeedSample>,
  now: () => number = Date.now,
  ttlMs = 2 * 60 * 1000,
) {
  let cached: { mbps: number; at: number } | null = null;
  let inflight: Promise<number | null> | null = null;

  const run = async (): Promise<number | null> => {
    try {
      const sample = await measure();
      const mbps = mbpsFrom(sample.bytes, sample.ms);
      if (mbps !== null) cached = { mbps, at: now() };
      return mbps;
    } catch {
      return null; // offline / server unreachable: caller falls back
    }
  };

  return {
    get(): Promise<number | null> {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.mbps);
      if (!inflight) {
        inflight = run().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    // The last result, without measuring.
    last: () => (cached ? cached.mbps : null),
  };
}
