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

// --- Explicit audio mode ("listen as audio") ---------------------------------

{
  // starts where the (playing) video is, advanced by the time since it was observed
  const { h, log } = rig({ observed: { seconds: 60, at: 1000 }, playingAt: 1900, now: 3000 });
  h.enterAudioMode();
  await tick();
  check('entering audio mode pauses the video and starts audio at the video position + elapsed', JSON.stringify(log) === JSON.stringify([['pauseVideo'], ['startAudio', 62]]), log);
  check('it reports audio active and explicit', h.isAudioActive() && h.isExplicit());
}

{
  // a paused video: audio starts where it stopped, not later
  const { h, log } = rig({ observed: { seconds: 60, at: 1000 }, playingAt: 1000, now: 60_000 });
  h.enterAudioMode();
  await tick();
  check('a paused video starts audio at exactly where it stopped', log.some((e) => e[0] === 'startAudio' && e[1] === 60), log);
}

{
  // nothing observed yet: start at the beginning
  const { h, log } = rig({ observed: null });
  h.enterAudioMode();
  await tick();
  check('with no known position audio starts at 0', log.some((e) => e[0] === 'startAudio' && e[1] === 0), log);
}

{
  // the app coming on screen / leaving must not hand audio mode back to the video
  const { h, log } = rig();
  h.enterAudioMode();
  await tick();
  const before = log.length;
  h.handleAppState('background');
  h.handleAppState('active');
  h.handleAppState('background');
  h.handleAppState('active');
  await tick();
  check('app-state changes do nothing while in audio mode', log.length === before, log.slice(before));
  check('and it is still audio', h.isAudioActive() && h.isExplicit());
}

{
  // switching back to video
  const { h, log } = rig();
  h.enterAudioMode();
  await tick();
  h.exitAudioMode();
  check('leaving audio mode stops audio and resumes the video where it got to', JSON.stringify(log.slice(-2)) === JSON.stringify([['stopAudio'], ['resumeVideo', 75.5, true]]), log);
  check('and it is no longer audio', !h.isAudioActive() && !h.isExplicit());
  h.handleAppState('background');
  await tick();
  check('after that the automatic background handoff works again', log.filter((e) => e[0] === 'startAudio').length === 2, log);
}

{
  // a background handoff already running becomes the chosen mode without restarting
  const { h, log } = rig();
  h.handleAppState('background');
  await tick();
  h.enterAudioMode();
  await tick();
  check('choosing audio while a background handoff is running keeps the same audio', log.filter((e) => e[0] === 'startAudio').length === 1, log);
  h.handleAppState('active');
  check('and coming back to the app then leaves it as audio', h.isAudioActive() && !log.some((e) => e[0] === 'stopAudio'), log);
}

{
  // choosing audio then immediately video, while the audio is still starting
  let release;
  const { h, log } = rig({ startAudio: () => new Promise((r) => (release = r)) });
  h.enterAudioMode();
  await tick();
  h.exitAudioMode();
  release();
  await tick();
  await tick();
  check('switching back before audio finished starting stops it as soon as it is up', JSON.stringify(log.slice(-2)) === JSON.stringify([['stopAudio'], ['resumeVideo', 75.5, true]]), log);
  check('and nothing is left active', !h.isAudioActive() && !h.isExplicit());
}

{
  // audio cannot start
  const failures = [];
  const { h, log } = rig({ startAudio: () => Promise.reject(new Error('no network')), onExplicitFailed: () => failures.push('failed') });
  h.enterAudioMode();
  await tick();
  check('a failed start is reported to the UI so the switch can flip back', failures.length === 1, failures);
  check('audio mode is off again and error reported', !h.isExplicit() && !h.isAudioActive() && log.some((e) => e[0] === 'error'), log);
  h.enterAudioMode();
  await tick();
  check('and it can be tried again', failures.length === 2, failures);
}

{
  // a throwing onExplicitFailed must not escape either
  const { h } = rig({ startAudio: () => Promise.reject(new Error('x')), onExplicitFailed: () => { throw new Error('ui gone'); } });
  let escaped = null;
  try { h.enterAudioMode(); await tick(); } catch (e) { escaped = e; }
  check('a throwing UI callback does not escape', escaped === null, String(escaped));
}

// --- Autoplay: track end and skipping ---------------------------------------

{
  // track ends in audio mode: advance to the next, then follow with audio
  let advanced = 0;
  const { h, log } = rig({ advanceAudio: async () => { advanced++; return true; } });
  h.enterAudioMode();
  await tick();
  h.handleAudioEnded();
  await tick();
  check('a finished audio track asks for the next video', advanced === 1);
  h.handleVideoChanged();
  await tick();
  check('the audio then follows to the new video from its start', log.filter((e) => e[0] === 'startAudio').length === 2 && log.at(-1)[1] === 0, log);
}

{
  const { h, log } = rig({ advanceAudio: async () => false });
  h.enterAudioMode();
  await tick();
  h.handleAudioEnded();
  await tick();
  check('no next video: nothing else happens (no crash, no restart)', log.filter((e) => e[0] === 'startAudio').length === 1 && !log.some((e) => e[0] === 'error'), log);
}

{
  const { h, log } = rig({ advanceAudio: async () => { throw new Error('queue broke'); } });
  h.enterAudioMode();
  await tick();
  let escaped = null;
  try { h.handleAudioEnded(); await tick(); } catch (e) { escaped = e; }
  check('a failing advance is contained and reported', escaped === null && log.some((e) => e[0] === 'error' && e[1] === 'queue broke'), [escaped, log]);
}

{
  const { h } = rig({ advanceAudio: () => { throw new Error('sync throw'); } });
  h.enterAudioMode();
  await tick();
  let escaped = null;
  try { h.handleAudioEnded(); await tick(); } catch (e) { escaped = e; }
  check('a synchronously throwing advance is contained too', escaped === null, String(escaped));
}

{
  let advanced = 0;
  const { h } = rig({ advanceAudio: async () => { advanced++; return true; } });
  h.handleAudioEnded();
  await tick();
  check('an audio-ended event when audio is not active is ignored', advanced === 0);
}

{
  // skipping (next/prev) while audio plays retargets the audio; while it does not, nothing happens
  const { h, log } = rig();
  h.handleVideoChanged();
  await tick();
  check('a video change with no audio playing does nothing', log.length === 0, log);
  h.enterAudioMode();
  await tick();
  h.handleVideoChanged();
  await tick();
  check('a video change while audio plays restarts audio for it at 0', log.filter((e) => e[0] === 'startAudio').length === 2 && log.at(-1)[1] === 0, log);
}

{
  // skipping while the first audio is still starting: retargeted once it is up, not lost
  let release;
  let calls = 0;
  const { h, log } = rig({ startAudio: (from) => { calls++; log2.push(['startAudio', from]); return calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve(); } });
  const log2 = [];
  h.enterAudioMode();
  await tick();
  h.handleVideoChanged();          // skipped before the first audio came up
  release();
  await tick();
  await tick();
  check('a skip that arrives while audio is starting is applied afterwards', log2.length === 2 && log2[1][1] === 0, log2);
}

{
  // background handoff also advances when its track ends
  let advanced = 0;
  const { h } = rig({ advanceAudio: async () => { advanced++; return true; } });
  h.handleAppState('background');
  await tick();
  h.handleAudioEnded();
  await tick();
  check('a track ending during a background handoff also advances', advanced === 1);
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
