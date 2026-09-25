// Decides when playback moves between the YouTube video (only works while the
// app is on screen) and an audio-only stream (keeps playing with the screen off
// or in another app). Pure logic with injected side effects, so the tricky
// timing cases can be tested without React or a device.

// If the video was playing this recently when the app left the screen, treat it
// as "was playing". The embed tends to report itself paused a moment before we
// hear about the app going to the background, so the paused state alone would
// wrongly say the user had stopped it.
export const RECENTLY_PLAYING_MS = 2500;

export interface HandoffDeps {
  now: () => number;
  // Seconds into the video as last observed, and when it was observed.
  lastVideoTime: () => { seconds: number; at: number } | null;
  // Milliseconds timestamp of the last moment the video was known to be playing.
  lastPlayingAt: () => number | null;
  // Begin audio-only playback from this position. May reject (no network...).
  startAudio: (fromSeconds: number) => Promise<void>;
  // Stop audio-only playback and report where it got to. `seconds` may be NaN
  // if the position couldn't be read.
  stopAudio: () => { seconds: number; wasPlaying: boolean };
  // Bring the video back at this position, playing or paused.
  resumeVideo: (seconds: number, playing: boolean) => void;
  // Pause the video (it can't play in the background anyway).
  pauseVideo: () => void;
  onError?: (err: unknown) => void;
}

export type AppStateName = 'active' | 'inactive' | 'background' | 'unknown' | 'extension';

export interface Handoff {
  handleAppState: (state: AppStateName) => void;
  // True while audio-only playback owns the session.
  isAudioActive: () => boolean;
}

export function createHandoff(deps: HandoffDeps): Handoff {
  let audioActive = false;
  // Audio takes a moment to start (network). If the app comes back on screen
  // before it has, the audio must be stopped the instant it does start,
  // otherwise it would play over the video.
  let starting = false;
  let returnedWhileStarting = false;
  // Where and when audio started, to estimate the position if the audio engine
  // can't be asked for it when the app returns.
  let audioFrom = 0;
  let audioStartedAt = 0;

  // These run from an app-state event with nothing above them to catch an
  // error, and an uncaught one closes the app. The handoff is a nicety, so a
  // failing step is reported and skipped rather than allowed to take the app
  // down.
  function attempt(step: () => void) {
    try {
      step();
    } catch (err) {
      deps.onError?.(err);
    }
  }

  function toBackground() {
    if (audioActive || starting) return;

    const playingAt = deps.lastPlayingAt();
    if (playingAt === null || deps.now() - playingAt > RECENTLY_PLAYING_MS) return;

    const observed = deps.lastVideoTime();
    if (!observed) return;
    // The video kept playing after that observation, so advance the position by
    // the time since (never backwards).
    const elapsed = Math.max(0, (deps.now() - observed.at) / 1000);
    const from = observed.seconds + elapsed;

    starting = true;
    returnedWhileStarting = false;
    attempt(() => deps.pauseVideo());
    // startAudio may throw synchronously as well as reject.
    new Promise<void>((resolve, reject) => {
      try {
        deps.startAudio(from).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    })
      .then(() => {
        audioActive = true;
        audioFrom = from;
        audioStartedAt = deps.now();
        if (returnedWhileStarting) {
          returnedWhileStarting = false;
          toForeground();
        }
      })
      .catch((err) => {
        deps.onError?.(err);
        // Audio couldn't start; leave things as they were.
      })
      .finally(() => {
        starting = false;
      });
  }

  function toForeground() {
    if (starting && !audioActive) {
      returnedWhileStarting = true;
      return;
    }
    if (!audioActive) return;
    audioActive = false;

    let seconds = NaN;
    let wasPlaying = true;
    attempt(() => {
      const stopped = deps.stopAudio();
      seconds = stopped.seconds;
      wasPlaying = stopped.wasPlaying;
    });
    // If the position couldn't be read, assume it played on from where it
    // started rather than snapping the video somewhere wrong.
    if (!Number.isFinite(seconds)) {
      seconds = audioFrom + Math.max(0, (deps.now() - audioStartedAt) / 1000);
    }
    attempt(() => deps.resumeVideo(seconds, wasPlaying));
  }

  return {
    handleAppState(state) {
      if (state === 'background') toBackground();
      else if (state === 'active') toForeground();
      // 'inactive' is transient (notification shade, app switcher on iOS):
      // the app is still on screen, so the video keeps going.
    },
    isAudioActive: () => audioActive,
  };
}
