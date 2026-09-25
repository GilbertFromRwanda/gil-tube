// Decides when playback moves between the YouTube video (only works while the
// app is on screen) and an audio-only stream (keeps playing with the screen off
// or in another app). Pure logic with injected side effects, so the tricky
// timing cases can be tested without React or a device.
//
// Audio can take over two ways:
//   - automatically, when the app leaves the screen while a video is playing
//     (and hands back when the app returns), or
//   - explicitly, when the user chooses "audio" mode: then it stays audio no
//     matter what the app is doing, moves on through the queue when a track
//     ends, and only goes back to video when the user switches back.

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
  // Begin audio-only playback of the current video from this position. May
  // reject (no network...).
  startAudio: (fromSeconds: number) => Promise<void>;
  // Stop audio-only playback and report where it got to. `seconds` may be NaN
  // if the position couldn't be read.
  stopAudio: () => { seconds: number; wasPlaying: boolean };
  // Bring the video back at this position, playing or paused.
  resumeVideo: (seconds: number, playing: boolean) => void;
  // Pause the video (it can't play in the background anyway).
  pauseVideo: () => void;
  // The audio track finished: make the next video the current one. Resolves
  // false if there is no next. The audio for it is then started through
  // handleVideoChanged().
  advanceAudio?: () => Promise<boolean>;
  // Audio mode was requested but the audio could not start.
  onExplicitFailed?: () => void;
  onError?: (err: unknown) => void;
}

export type AppStateName = 'active' | 'inactive' | 'background' | 'unknown' | 'extension';

export interface Handoff {
  handleAppState: (state: AppStateName) => void;
  // True while audio-only playback owns the session.
  isAudioActive: () => boolean;
  // True while the user has chosen audio mode.
  isExplicit: () => boolean;
  enterAudioMode: () => void;
  exitAudioMode: () => void;
  // The audio track reached its end.
  handleAudioEnded: () => void;
  // The current video changed (next / previous / autoplay): follow it with audio.
  handleVideoChanged: () => void;
}

export function createHandoff(deps: HandoffDeps): Handoff {
  let audioActive = false;
  let explicit = false;
  // Audio takes a moment to start (network). If the app comes back on screen
  // before it has, the audio must be stopped the instant it does start,
  // otherwise it would play over the video.
  let starting = false;
  let returnedWhileStarting = false;
  // The video changed while audio was still starting for the previous one.
  let retargetAfterStart = false;
  // Where and when audio started, to estimate the position if the audio engine
  // can't be asked for it when the app returns.
  let audioFrom = 0;
  let audioStartedAt = 0;

  // These run from events with nothing above them to catch an error, and an
  // uncaught one closes the app. The handoff is a nicety, so a failing step is
  // reported and skipped rather than allowed to take the app down.
  function attempt(step: () => void) {
    try {
      step();
    } catch (err) {
      deps.onError?.(err);
    }
  }

  // startAudio may throw synchronously as well as reject.
  function callStartAudio(from: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        deps.startAudio(from).then(resolve, reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  function begin(from: number) {
    starting = true;
    returnedWhileStarting = false;
    retargetAfterStart = false;
    attempt(() => deps.pauseVideo());
    callStartAudio(from)
      .then(() => {
        audioActive = true;
        audioFrom = from;
        audioStartedAt = deps.now();
        if (returnedWhileStarting && !explicit) {
          returnedWhileStarting = false;
          toForeground();
        } else if (retargetAfterStart) {
          // A skip arrived while this audio was starting; apply it now. (Not
          // through handleVideoChanged: `starting` is still true here, so it
          // would just queue itself again and the skip would be lost.)
          retargetAfterStart = false;
          retargetAudio();
        }
      })
      .catch((err) => {
        deps.onError?.(err);
        if (explicit) {
          explicit = false;
          attempt(() => deps.onExplicitFailed?.());
        }
        // Audio couldn't start; leave things as they were.
      })
      .finally(() => {
        starting = false;
      });
  }

  function toBackground() {
    // Already audio (a background handoff in progress, or audio mode).
    if (audioActive || starting) return;

    const playingAt = deps.lastPlayingAt();
    if (playingAt === null || deps.now() - playingAt > RECENTLY_PLAYING_MS) return;

    const observed = deps.lastVideoTime();
    if (!observed) return;
    // The video kept playing after that observation, so advance the position by
    // the time since (never backwards).
    const elapsed = Math.max(0, (deps.now() - observed.at) / 1000);
    begin(observed.seconds + elapsed);
  }

  function toForeground() {
    // In audio mode the app coming on screen changes nothing.
    if (explicit) return;
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

  function enterAudioMode() {
    if (explicit) return;
    explicit = true;
    // Audio is already running (a background handoff): it just becomes the
    // chosen mode and stays.
    if (audioActive || starting) return;

    // Start where the video is. If it isn't playing, that position is where it
    // stopped; if it is, it has moved on since it was last observed.
    let from = 0;
    const observed = deps.lastVideoTime();
    if (observed) {
      const playingAt = deps.lastPlayingAt();
      const playing = playingAt !== null && deps.now() - playingAt <= RECENTLY_PLAYING_MS;
      from = observed.seconds + (playing ? Math.max(0, (deps.now() - observed.at) / 1000) : 0);
    }
    begin(from);
  }

  function exitAudioMode() {
    if (!explicit) return;
    explicit = false;
    if (audioActive) toForeground();
    // Still starting: begin()'s completion hands back once it sees explicit off.
    else if (starting) returnedWhileStarting = true;
  }

  function handleAudioEnded() {
    if (!audioActive || !deps.advanceAudio) return;
    try {
      deps.advanceAudio().catch((err) => deps.onError?.(err));
    } catch (err) {
      deps.onError?.(err);
    }
  }

  // Follow the current video from its beginning.
  function retargetAudio() {
    callStartAudio(0)
      .then(() => {
        audioFrom = 0;
        audioStartedAt = deps.now();
      })
      .catch((err) => deps.onError?.(err));
  }

  function handleVideoChanged() {
    if (!audioActive && !starting) return;
    if (starting) {
      retargetAfterStart = true;
      return;
    }
    retargetAudio();
  }

  return {
    handleAppState(state) {
      if (state === 'background') toBackground();
      else if (state === 'active') toForeground();
      // 'inactive' is transient (notification shade, app switcher on iOS):
      // the app is still on screen, so the video keeps going.
    },
    isAudioActive: () => audioActive,
    isExplicit: () => explicit,
    enterAudioMode,
    exitAudioMode,
    handleAudioEnded,
    handleVideoChanged,
  };
}
