// Tests the web UI's endless-feed logic (web/index.html) with a fake network and
// DOM: the code is cut out of the page itself, so this tests what ships.
//   node scripts/test-web-feed.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8');
const start = html.indexOf('// ---- The feed');
const end = html.indexOf("searchForm.addEventListener('submit'");
if (start < 0 || end < 0) throw new Error('could not find the feed code in web/index.html');
const feedCode = html.slice(start, end);

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const video = (n) => ({ id: `v${String(n).padStart(9, '0')}`.slice(0, 11), title: `T${n}`, url: `https://y/${n}` });

// Builds the feed code inside a sandbox with controllable pieces.
function sandbox({ pages = {}, cachedMore = false } = {}) {
  const calls = [];
  const appended = [];
  const nodes = [];
  const fakeSearchResults = {
    insertAdjacentHTML: (_pos, markup) => {
      if (markup.includes('feed-skeleton')) for (let i = 0; i < 4; i++) nodes.push({ cls: 'feed-skeleton' });
      if (markup.includes('feed-end')) nodes.push({ cls: 'feed-end' });
    },
    querySelectorAll: (sel) =>
      nodes.filter((n) => '.' + n.cls === sel).map((n) => ({ remove: () => nodes.splice(nodes.indexOf(n), 1) })),
    classList: { add() {}, remove() {} },
  };
  const env = {
    API_BASE: 'http://api',
    searchResults: fakeSearchResults,
    searchError: { classList: { add() {}, remove() {} }, textContent: '' },
    searchButton: { disabled: false, textContent: '' },
    showSearchSkeletons() {},
    clearSearchSkeletons() {},
    setResultsHeading() {},
    renderSearchResults(list) {
      appended.push(['render', list.map((r) => r.id)]);
    },
    appendSearchResults(list) {
      appended.push(['append', list.map((r) => r.id)]);
    },
    currentResultsList: [1],
    cachedVideosHasMore: cachedMore,
    loadMoreCachedVideos: async () => {
      calls.push('cached');
    },
    fetch: (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(`page@${body.offset}x${body.limit}`);
      const impl = pages[body.offset];
      const respond = (data) => ({ ok: true, json: async () => data });
      if (typeof impl === 'function') return impl(body).then(respond);
      if (impl instanceof Error) return Promise.reject(impl);
      return Promise.resolve(respond(impl));
    },
  };
  const names = Object.keys(env);
  const factory = new Function(
    ...names,
    `${feedCode}
    return {
      takeNewResults, loadMoreFeed, runSearch, feedHasMore,
      get: () => ({ searchOffset, searchHasMore, loadingMoreFeed, feedGeneration, seen: [...shownVideoIds] }),
      set: (o) => {
        if ('searchOffset' in o) searchOffset = o.searchOffset;
        if ('searchHasMore' in o) searchHasMore = o.searchHasMore;
        if ('feedQuery' in o) feedQuery = o.feedQuery;
        if ('seen' in o) o.seen.forEach((i) => shownVideoIds.add(i));
      },
    };`
  );
  const api = factory(...names.map((n) => env[n]));
  return { api, calls, appended, nodes };
}

// 1. dedupe helper
{
  const { api } = sandbox();
  const seen = new Set(['a']);
  const fresh = api.takeNewResults([{ id: 'a' }, { id: 'b' }, { id: 'b' }, {}, null, { id: 'c' }], seen);
  check('takeNewResults drops seen, duplicate, id-less and null entries', JSON.stringify(fresh.map((r) => r.id)) === '["b","c"]', fresh);
  check('and remembers what it returned', seen.has('b') && seen.has('c'));
}

// 2. a normal page loads, dedupes against what is shown, advances the offset, prefetches the next
{
  const { api, calls, appended, nodes } = sandbox({
    pages: {
      12: { results: [video(1), video(2), video(3)], next_offset: 36, has_more: true },
      36: { results: [video(9)], next_offset: 60, has_more: true },
    },
  });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true, seen: [video(2).id] });
  await api.loadMoreFeed();
  await tick();
  check('asks for the next window with the page size', calls[0] === 'page@12x24', calls);
  check('appends only the videos not already shown', JSON.stringify(appended) === JSON.stringify([['append', [video(1).id, video(3).id]]]), appended);
  check('advances the offset from next_offset', api.get().searchOffset === 36 && api.get().searchHasMore === true, api.get());
  check('prefetches the following page in the background', calls.includes('page@36x24'), calls);
  check('but does not show the prefetched page yet', appended.length === 1, appended);
  check('skeletons are cleared and the loading flag released', nodes.filter((n) => n.cls === 'feed-skeleton').length === 0 && api.get().loadingMoreFeed === false, nodes);
}

// 3. the prefetched page is reused, not fetched twice
{
  const { api, calls } = sandbox({
    pages: {
      12: { results: [video(1)], next_offset: 36, has_more: true },
      36: { results: [video(2)], next_offset: 60, has_more: true },
      60: { results: [], next_offset: 84, has_more: false },
    },
  });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true });
  await api.loadMoreFeed();
  await tick();
  await api.loadMoreFeed();
  await tick();
  check('a prefetched page is reused (offset 36 fetched exactly once)', calls.filter((c) => c === 'page@36x24').length === 1, calls);
}

// 4. a page that is all repeats is skipped automatically
{
  const { api, calls, appended } = sandbox({
    pages: {
      12: { results: [video(1), video(2)], next_offset: 36, has_more: true },
      36: { results: [video(1), video(2)], next_offset: 60, has_more: true },
      60: { results: [video(7)], next_offset: 84, has_more: true },
      84: { results: [], next_offset: 108, has_more: true },
    },
  });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true, seen: [video(1).id, video(2).id] });
  await api.loadMoreFeed();
  await tick();
  check('an all-repeats page triggers the next one without another scroll', calls.slice(0, 3).join() === 'page@12x24,page@36x24,page@60x24', calls);
  check('and the new video is what gets appended', JSON.stringify(appended.filter((a) => a[1].length)) === JSON.stringify([['append', [video(7).id]]]), appended);
}

// 5. gives up after several empty pages instead of hammering YouTube
{
  const pages = {};
  for (let i = 0; i < 10; i++) pages[12 + i * 24] = { results: [video(1)], next_offset: 36 + i * 24, has_more: true };
  const { api, calls } = sandbox({ pages });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true, seen: [video(1).id] });
  await api.loadMoreFeed();
  await tick();
  check('stops after 4 consecutive all-repeat pages (bounded work)', calls.filter((c) => c.startsWith('page@')).length <= 5, calls);
  check('and is not stuck loading', api.get().loadingMoreFeed === false);
}

// 6. the end of the results
{
  const { api, calls, nodes } = sandbox({ pages: { 12: { results: [video(4)], next_offset: 36, has_more: false } } });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true });
  await api.loadMoreFeed();
  await tick();
  check('has_more false shows the end-of-results note', nodes.some((n) => n.cls === 'feed-end'), nodes);
  check('and nothing more is requested', !api.feedHasMore());
  const before = calls.length;
  await api.loadMoreFeed();
  await tick();
  check('further scrolling does not call the server', calls.length === before, calls);
}

// 7. only one load in flight at a time
{
  let release;
  const { api, calls } = sandbox({
    pages: {
      12: () =>
        new Promise((r) => {
          release = () => r({ results: [video(5)], next_offset: 36, has_more: false });
        }),
    },
  });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true });
  const first = api.loadMoreFeed();
  await tick();
  await api.loadMoreFeed();
  await api.loadMoreFeed();
  check('repeated scroll events while loading do not start more requests', calls.filter((c) => c === 'page@12x24').length === 1, calls);
  release();
  await first;
}

// 8. a slow reply for an old search must not land in a new list
{
  let release;
  const { api, appended } = sandbox({
    pages: {
      12: () =>
        new Promise((r) => {
          release = () => r({ results: [video(6)], next_offset: 36, has_more: true });
        }),
      0: { results: [video(8)], next_offset: 12, has_more: true },
    },
  });
  api.set({ feedQuery: 'old', searchOffset: 12, searchHasMore: true });
  const slow = api.loadMoreFeed();
  await tick();
  await api.runSearch('new'); // a new search starts while the old page is in flight
  release();
  await slow;
  await tick();
  const appendedIds = appended.filter((a) => a[0] === 'append').flatMap((a) => a[1]);
  check("the old search's late page is ignored", !appendedIds.includes(video(6).id), appended);
  check('the new search is what is shown', appended.some((a) => a[0] === 'render' && a[1].includes(video(8).id)), appended);
  check('and it is not left stuck loading', api.get().loadingMoreFeed === false);
}

// 9. a failed page is retried, not remembered as failed
{
  let attempt = 0;
  const { api, calls, nodes } = sandbox({
    pages: { 12: () => (++attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ results: [video(3)], next_offset: 36, has_more: false })) },
  });
  api.set({ feedQuery: 'q', searchOffset: 12, searchHasMore: true });
  await api.loadMoreFeed();
  await tick();
  check(
    'a failed page leaves the feed usable (no stuck spinner, more still expected)',
    api.get().loadingMoreFeed === false && api.feedHasMore() && !nodes.some((n) => n.cls === 'feed-skeleton'),
    api.get()
  );
  await api.loadMoreFeed();
  await tick();
  check('the same page is fetched again on the next scroll and succeeds', calls.filter((c) => c === 'page@12x24').length === 2 && !api.feedHasMore(), calls);
}

// 10. the cached feed goes first
{
  const { api, calls } = sandbox({ cachedMore: true });
  await api.loadMoreFeed();
  await tick();
  check('while the cached feed has more, load-more uses it, not the live search', calls.length === 1 && calls[0] === 'cached', calls);
}

// 11. a brand-new search: first page uses the first-page size and resets state
{
  const { api, calls, appended } = sandbox({ pages: { 0: { results: [video(1), video(2)], next_offset: 12, has_more: true } } });
  api.set({ seen: ['stale'] });
  await api.runSearch('rwanda');
  check('a new search asks for offset 0 at the first-page size (keeps existing cache hits)', calls[0] === 'page@0x12', calls);
  check('it renders the page and sets up paging', appended[0][0] === 'render' && api.get().searchOffset === 12 && api.get().searchHasMore === true, [appended, api.get()]);
  check('it forgets what the previous feed had shown', !api.get().seen.includes('stale'), api.get());
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
