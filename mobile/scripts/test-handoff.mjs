// Tests for the background-audio handoff rules (src/player/handoff.ts) using
// fake players - no device, React or native code needed.
//
//   npm run test:handoff        (Node 22.18+/24 runs the .ts import directly)
import { createHandoff, RECENTLY_PLAYING_MS } from '../src/player/handoff.ts';

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig({ observed = { seconds: 60, at: 1000 }, playingAt = 1000, now = 2000, ...overrides } = {}) {
  const t = { now, observed, playingAt };
  const log = [];
  const deps = {
    now: () => t.now,
    lastVideoTime: () => t.observed,
    lastPlayingAt: () => t.playingAt,
    startAudio: async (from) => {
      log.push(['startAudio', +from.toFixed(2)]);
    },
    stopAudio: () => {
      log.push(['stopAudio']);
      return { seconds: 75.5, wasPlaying: true };
    },
    resumeVideo: (s, p) => log.push(['resumeVideo', +s.toFixed(2), p]),
    pauseVideo: () => log.push(['pauseVideo']),
    onError: (e) => log.push(['error', String(e.message || e)]),
    ...overrides,
  };
  return { h: createHandoff(deps), log, t };
}

// --- The rules -------------------------------------------------------------

{
  const { h, log } = rig({ observed: { seconds: 60, at: 1000 }, now: 3500 });
  h.handleAppState('background');
  await tick();
  check('background while playing starts audio at observed time + elapsed', JSON.stringify(log) === JSON.stringify([['pauseVideo'], ['startAudio', 62.5]]), log);
  check('audio is now active', h.isAudioActive());
  h.handleAppState('active');
  check('foreground stops audio and resumes video at the audio position', JSON.stringify(log.slice(2)) === JSON.stringify([['stopAudio'], ['resumeVideo', 75.5, true]]), log);
  check('audio no longer active', !h.isAudioActive());
}

{
  const { h, log } = rig({ playingAt: 1000, now: 1000 + RECENTLY_PLAYING_MS + 1 });
  h.handleAppState('background');
  await tick();
  h.handleAppState('active');
  await tick();
  check('video paused by the user earlier: no handoff', log.length === 0, log);
}

{
  const { h, log } = rig({ playingAt: 1900, now: 2000 });
  h.handleAppState('background');
  await tick();
  check('recently playing (pause event raced the background event): hands off', log.some((e) => e[0] === 'startAudio'), log);
}

{
  const { h, log } = rig();
  h.handleAppState('inactive');
  await tick();
  check('inactive (notification shade) does nothing', log.length === 0, log);
}

{
  const { h, log } = rig();
  h.handleAppState('background');
  h.handleAppState('background');
  await tick();
  h.handleAppState('background');
  await tick();
  check('repeated background events start audio once', log.filter((e) => e[0] === 'startAudio').length === 1, log);
}

{
  const { h, log } = rig({ startAudio: () => Promise.reject(new Error('no network')) });
  h.handleAppState('background');
  await tick();
  check('start failure reported', log.some((e) => e[0] === 'error' && e[1] === 'no network'), log);
  check('start failure leaves audio inactive', !h.isAudioActive());
  h.handleAppState('active');
  await tick();
  check('foreground after a failed start stops/resumes nothing', !log.some((e) => e[0] === 'stopAudio' || e[0] === 'resumeVideo'), log);
}

{
  let release;
  const { h, log } = rig({ startAudio: () => new Promise((r) => (release = r)) });
  h.handleAppState('background');
  await tick();
  h.handleAppState('active');
  await tick();
  check('returning mid-start does not stop anything yet', !log.some((e) => e[0] === 'stopAudio'), log);
  release();
  await tick();
  await tick();
  check('audio that finishes starting after we returned is stopped and video resumed', JSON.stringify(log.slice(-2)) === JSON.stringify([['stopAudio'], ['resumeVideo', 75.5, true]]), log);
  check('nothing left active', !h.isAudioActive());
}

{
  const { h, log } = rig();
  h.handleAppState('background');
  await tick();
  h.handleAppState('active');
  await tick();
  h.handleAppState('background');
  await tick();
  check('second round trip hands off again', log.filter((e) => e[0] === 'startAudio').length === 2, log);
}

{
  const { h, log } = rig({ observed: null });
  h.handleAppState('background');
  await tick();
  check('unknown position: no handoff', log.length === 0, log);
}

// --- Failures must never escape (an uncaught error in an app-state listener
// --- closes a release app: this is the crash on returning to the app) --------

{
  const { h, log, t } = rig({ observed: { seconds: 60, at: 10_000 }, playingAt: 10_000, now: 10_000, stopAudio: () => { throw new Error('native replace(null) rejected'); } });
  h.handleAppState('background');
  await tick();
  t.now += 4000; // audio ran for 4s while away
  let escaped = null;
  try {
    h.handleAppState('active');
  } catch (e) {
    escaped = e;
  }
  check('a throwing stopAudio does not escape into the app-state handler', escaped === null, String(escaped));
  check('the error is reported instead', log.some((e) => e[0] === 'error' && /native replace/.test(e[1])), log);
  const resume = log.find((e) => e[0] === 'resumeVideo');
  check('video still resumes at start position + time away (60 + 4s), playing', resume && resume[1] === 64 && resume[2] === true, log);
  check('handoff is no longer active afterwards', !h.isAudioActive());
}

{
  const { h, log, t } = rig({ observed: { seconds: 60, at: 10_000 }, playingAt: 10_000, now: 10_000, stopAudio: () => ({ seconds: NaN, wasPlaying: true }) });
  h.handleAppState('background');
  await tick();
  t.now += 2500;
  h.handleAppState('active');
  const resume = log.find((e) => e[0] === 'resumeVideo');
  check('NaN position falls back to the estimate instead of seeking to NaN', resume && resume[1] === 62.5, log);
}

{
  const { h, log } = rig({ resumeVideo: () => { throw new Error('webview not ready'); } });
  h.handleAppState('background');
  await tick();
  let escaped = null;
  try {
    h.handleAppState('active');
  } catch (e) {
    escaped = e;
  }
  check('a throwing resumeVideo does not escape', escaped === null, String(escaped));
  check('it is reported', log.some((e) => e[0] === 'error' && /webview/.test(e[1])), log);
}

{
  const { h, log } = rig({ pauseVideo: () => { throw new Error('webview gone'); } });
  let escaped = null;
  try {
    h.handleAppState('background');
  } catch (e) {
    escaped = e;
  }
  await tick();
  check('a throwing pauseVideo does not escape', escaped === null, String(escaped));
  check('audio still starts', log.some((e) => e[0] === 'startAudio'), log);
}

{
  const { h, log } = rig({ startAudio: () => { throw new Error('bad url'); } });
  let escaped = null;
  try {
    h.handleAppState('background');
  } catch (e) {
    escaped = e;
  }
  await tick();
  check('a synchronously throwing startAudio does not escape', escaped === null, String(escaped));
  check('it is reported and nothing is left active', log.some((e) => e[0] === 'error' && e[1] === 'bad url') && !h.isAudioActive(), log);
  h.handleAppState('active');
  h.handleAppState('background');
  await tick();
  check('a later background event can try again', log.filter((e) => e[0] === 'error').length === 2, log);
}

{
  const { h, log } = rig({ observed: { seconds: 60, at: 1000 }, now: 1000 });
  h.handleAppState('background');
  await tick();
  h.handleAppState('active');
  check('normal round trip unchanged', JSON.stringify(log) === JSON.stringify([['pauseVideo'], ['startAudio', 60], ['stopAudio'], ['resumeVideo', 75.5, true]]), log);
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
