// Tests the web UI's next / previous / autoplay logic (web/index.html) with a
// fake player and feed: the code is cut out of the page itself, so this tests
// what ships.
//   node scripts/test-web-queue.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8');
const start = html.indexOf('// ---- Play queue');
const end = html.indexOf('// ---- end play queue');
if (start < 0 || end < 0) throw new Error('could not find the play-queue code in web/index.html');
const code = html.slice(start, end);

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const v = (n) => ({ id: `id${n}`, title: `T${n}`, url: `https://y/${n}` });
const vids = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => v(a + i));

// Builds the queue code with a fake feed, player and buttons. `currentResultsList` and
// `loadingMoreFeed` are variables in the page, so they are provided as getters on a
// `with` scope.
function build(opts = {}) {
  const { initial = vids(1, 3), pages = [], position = 0, slowLoads = false } = opts;
  const log = [];
  const state = { list: initial.slice(), loads: 0, loading: false, position };
  let api;
  const prevButton = { disabled: true, addEventListener() {} };
  const nextButton = { disabled: true, addEventListener() {} };
  const autoplayToggle = { checked: true, addEventListener() {} };
  const localStorage = { getItem: () => null, setItem() {} };
  const ytPlayer = {
    seekTo: (s) => log.push(`seek:${s}`),
    playVideo: () => log.push('play'),
    getCurrentTime: () => state.position,
  };
  const ctx = {
    feedHasMore: () => state.loads < pages.length,
    loadMoreFeed: async () => {
      if (state.loading || state.loads >= pages.length) return;
      state.loading = true;
      if (slowLoads) await new Promise((r) => setTimeout(r, 30));
      state.list = state.list.concat(pages[state.loads++]);
      state.loading = false;
    },
    selectSearchResult: (result) => {
      log.push(`select:${result.id}`);
      api.setPlaying(result.id);
    },
  };
  // `currentResultsList` and `loadingMoreFeed` are variables in the page, so they
  // are provided as getters on a `with` scope.
  const scope = {
    prevButton, nextButton, autoplayToggle, localStorage, ytPlayer, ytPlayerReady: true,
    feedHasMore: ctx.feedHasMore, loadMoreFeed: ctx.loadMoreFeed, selectSearchResult: ctx.selectSearchResult,
    get currentResultsList() { return state.list; },
    get loadingMoreFeed() { return state.loading; },
  };
  const factory = new Function(
    'scope',
    `with (scope) {
       ${code}
       return { canGoPrev, canGoNext, playNext, playPrev, handleVideoEnded, updateQueueButtons,
                setPlaying: (id) => { playingId = id; endedFor = null; },
                setAutoplay: (on) => { autoplayOn = on; } };
     }`,
  );
  api = factory(scope);
  return { api, state, log, prevButton, nextButton };
}

// 1. plain navigation
{
  const t = build();
  t.api.setPlaying('id2');
  t.api.updateQueueButtons();
  check('in the middle both buttons are enabled', !t.prevButton.disabled && !t.nextButton.disabled);
  check('next plays the following result', (await t.api.playNext()) === true && t.log.at(-1) === 'select:id3', t.log);
  t.api.setPlaying('id2');
  t.state.position = 1;
  check('previous near the start goes back one', t.api.playPrev(1) === true && t.log.at(-1) === 'select:id1', t.log);
}

// 2. previous restarts when well into a video, or at the first one
{
  const t = build();
  t.api.setPlaying('id2');
  check('previous past 3s restarts instead of going back', t.api.playPrev(10) === false && t.log.join() === 'seek:0,play', t.log);
  const u = build();
  u.api.setPlaying('id1');
  u.api.updateQueueButtons();
  check('the first video has no previous button', u.prevButton.disabled === true);
  check('and previous just restarts it', u.api.playPrev(1) === false && u.log.join() === 'seek:0,play', u.log);
}

// 3. the end of the loaded list pulls in more of the feed
{
  const t = build({ pages: [vids(4, 6)] });
  t.api.setPlaying('id3');
  t.api.updateQueueButtons();
  check('at the end with more available, next is enabled', t.nextButton.disabled === false);
  check('next loads more and plays its first video', (await t.api.playNext()) === true && t.log.at(-1) === 'select:id4', t.log);
}

// 4. the real end
{
  const t = build();
  t.api.setPlaying('id3');
  t.api.updateQueueButtons();
  check('no more anywhere: next is disabled', t.nextButton.disabled === true);
  check('and next does nothing', (await t.api.playNext()) === false && t.log.length === 0, t.log);
}

// 5. a load already running (scroll) is waited for
{
  const t = build({ pages: [vids(4, 6)], slowLoads: true });
  t.api.setPlaying('id3');
  const scroll = t.state.loading === false ? (async () => {
    // simulate the scroll starting the load
    t.state.loading = true;
    await new Promise((r) => setTimeout(r, 40));
    t.state.list = t.state.list.concat(vids(4, 6));
    t.state.loads = 1;
    t.state.loading = false;
  })() : null;
  await tick();
  const moved = await t.api.playNext();
  await scroll;
  check('next waits for the load in progress and then plays', moved === true && t.log.at(-1) === 'select:id4', t.log);
}

// 6. another search replaces the list while a video plays
{
  const t = build({ initial: vids(1, 3) });
  t.api.setPlaying('id2');
  t.api.updateQueueButtons(); // remembers the list playback started from
  t.state.list = vids(101, 105);
  check('next stays inside the list playback started from', (await t.api.playNext()) === true && t.log.at(-1) === 'select:id3', t.log);
  t.api.setPlaying('id3');
  check('at the end of that old list it stops', (await t.api.playNext()) === false, t.log);
}

// 7. autoplay
{
  const t = build();
  t.api.setPlaying('id1');
  t.api.handleVideoEnded();
  await tick();
  check('a finished video plays the next when autoplay is on', t.log.at(-1) === 'select:id2', t.log);
  const u = build();
  u.api.setPlaying('id1');
  u.api.setAutoplay(false);
  u.api.handleVideoEnded();
  await tick();
  check('autoplay off: nothing happens at the end', u.log.length === 0, u.log);
  const w = build({ initial: vids(1, 3), pages: [vids(4, 6)], slowLoads: true });
  w.api.setPlaying('id3');
  w.api.handleVideoEnded(); // starts loading the next page...
  w.api.handleVideoEnded(); // ...a repeated ended report for the same video is ignored
  await new Promise((r) => setTimeout(r, 150));
  check('two ended reports while the next page loads only skip once', w.log.filter((l) => l.startsWith('select')).length === 1 && w.log[0] === 'select:id4', w.log);
}

// 8. a video that is not in the list (a pasted link)
{
  const t = build();
  t.api.setPlaying(null);
  t.api.updateQueueButtons();
  check('no list, no next or previous', t.nextButton.disabled && t.prevButton.disabled);
  check('and next does nothing', (await t.api.playNext()) === false);
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
