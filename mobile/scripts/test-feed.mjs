// Tests for the phone app's endless feed (src/feed/feedEngine.ts) with fake
// network functions - no device or React needed.
//   npm run test:feed
import { FeedEngine, MAX_EMPTY_PAGES, takeNewResults } from '../src/feed/feedEngine.ts';

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const video = (n) => ({ id: `v${String(n).padStart(9, '0')}`.slice(0, 11), title: `T${n}`, url: `https://y/${n}`, thumbnail: null, duration: 60, uploader: 'u' });
const ids = (list) => list.map((v) => v.id);

// pages: { [offset]: page | fn(offset, limit) -> Promise<page> | Error }, cached: array of pages by call
function make({ pages = {}, cachedPages = [] } = {}) {
  const calls = [];
  let changes = 0;
  let cachedCall = 0;
  const deps = {
    searchPage: (query, offset, limit, refresh) => {
      calls.push(`search:${query}@${offset}x${limit}${refresh ? ':refresh' : ''}`);
      const impl = pages[offset];
      if (typeof impl === 'function') return impl(offset, limit);
      if (impl instanceof Error) return Promise.reject(impl);
      return Promise.resolve(impl ?? { query, results: [], has_more: false, next_offset: offset + limit });
    },
    cachedPage: (offset, limit) => {
      calls.push(`cached@${offset}x${limit}`);
      const impl = cachedPages[cachedCall++];
      if (impl instanceof Error) return Promise.reject(impl);
      return Promise.resolve(impl ?? { videos: [], has_more: false });
    },
  };
  const engine = new FeedEngine(deps, () => changes++);
  return { engine, calls, changes: () => changes };
}

// 1. dedupe helper
{
  const seen = new Set(['a']);
  const fresh = takeNewResults([{ id: 'a' }, { id: 'b' }, { id: 'b' }, {}, null, { id: 'c' }], seen);
  check('takeNewResults drops seen, duplicate, id-less and null entries', JSON.stringify(fresh.map((r) => r.id)) === '["b","c"]', fresh);
}

// 2. a live search, then load-more pages it, dedupes, advances, prefetches
{
  const { engine, calls } = make({
    pages: {
      0: { query: 'q', results: [video(1), video(2)], has_more: true, next_offset: 12 },
      12: { query: 'q', results: [video(2), video(3), video(4)], has_more: true, next_offset: 36 },
      36: { query: 'q', results: [video(9)], has_more: true, next_offset: 60 },
    },
  });
  await engine.startSearch('q');
  check('the first page is requested at the first-page size, offset 0', calls[0] === 'search:q@0x12', calls);
  check('the first page is shown', JSON.stringify(ids(engine.snapshot().items)) === JSON.stringify([video(1).id, video(2).id]), engine.snapshot());
  await engine.loadMore();
  await tick();
  check('load-more asks for the next window at the page size', calls[1] === 'search:q@12x24', calls);
  check('repeats of what is already shown are dropped', JSON.stringify(ids(engine.snapshot().items)) === JSON.stringify([1, 2, 3, 4].map((n) => video(n).id)), engine.snapshot());
  check('the following page is prefetched, not shown', calls.includes('search:q@36x24') && !ids(engine.snapshot().items).includes(video(9).id), calls);
  await engine.loadMore();
  await tick();
  check('the prefetched page is reused (offset 36 requested once)', calls.filter((c) => c === 'search:q@36x24').length === 1, calls);
  check('and its videos appear', ids(engine.snapshot().items).includes(video(9).id));
}

// 3. an all-repeats page is skipped automatically, but only a bounded number of times
{
  const { engine, calls } = make({
    pages: {
      0: { query: 'q', results: [video(1)], has_more: true, next_offset: 12 },
      12: { query: 'q', results: [video(1)], has_more: true, next_offset: 36 },
      36: { query: 'q', results: [video(1)], has_more: true, next_offset: 60 },
      60: { query: 'q', results: [video(7)], has_more: true, next_offset: 84 },
    },
  });
  await engine.startSearch('q');
  await engine.loadMore();
  await tick();
  check('an all-repeats page triggers the next one without another scroll', calls.slice(1, 4).join() === 'search:q@12x24,search:q@36x24,search:q@60x24', calls);
  check('and the new video is added', ids(engine.snapshot().items).includes(video(7).id));

  const endless = {};
  endless[0] = { query: 'q', results: [video(1)], has_more: true, next_offset: 12 };
  for (let i = 0; i < 12; i++) endless[12 + i * 24] = { query: 'q', results: [video(1)], has_more: true, next_offset: 36 + i * 24 };
  const bounded = make({ pages: endless });
  await bounded.engine.startSearch('q');
  await bounded.engine.loadMore();
  await tick();
  const fetched = bounded.calls.filter((c) => c.startsWith('search:q@') && !c.includes('@0x')).length;
  check(`stops after ${MAX_EMPTY_PAGES} all-repeat pages (bounded work)`, fetched <= MAX_EMPTY_PAGES + 1, bounded.calls);
  check('and is not left loading', bounded.engine.snapshot().loadingMore === false);
}

// 4. the end
{
  const { engine, calls } = make({
    pages: {
      0: { query: 'q', results: [video(1)], has_more: true, next_offset: 12 },
      12: { query: 'q', results: [video(2)], has_more: false, next_offset: 36 },
    },
  });
  await engine.startSearch('q');
  check('mid-feed it is not ended', engine.snapshot().ended === false && engine.snapshot().hasMore === true);
  await engine.loadMore();
  await tick();
  check('has_more false marks the feed ended', engine.snapshot().ended === true && engine.snapshot().hasMore === false, engine.snapshot());
  const before = calls.length;
  await engine.loadMore();
  check('a further load-more does not call the server', calls.length === before, calls);
}

// 5. only one load in flight
{
  let release;
  const { engine, calls } = make({
    pages: {
      0: { query: 'q', results: [video(1)], has_more: true, next_offset: 12 },
      12: () => new Promise((r) => (release = () => r({ query: 'q', results: [video(5)], has_more: false, next_offset: 36 }))),
    },
  });
  await engine.startSearch('q');
  const first = engine.loadMore();
  await tick();
  await engine.loadMore();
  await engine.loadMore();
  check('repeated onEndReached calls while loading start nothing new', calls.filter((c) => c === 'search:q@12x24').length === 1, calls);
  check('loadingMore is reported while in flight', engine.snapshot().loadingMore === true);
  release();
  await first;
  check('and released afterwards', engine.snapshot().loadingMore === false);
}

// 6. a slow reply for an old search must not land in a new list
{
  let release;
  const { engine } = make({
    pages: {
      0: (offset) => Promise.resolve({ query: 'new', results: [video(8)], has_more: true, next_offset: 12 }),
      12: () => new Promise((r) => (release = () => r({ query: 'old', results: [video(6)], has_more: true, next_offset: 36 }))),
    },
  });
  await engine.startSearch('old');
  // re-point page 0 for the "new" search
  const slow = engine.loadMore();
  await tick();
  await engine.startSearch('new');
  release();
  await slow;
  await tick();
  check("the old search's late page is ignored", !ids(engine.snapshot().items).includes(video(6).id), engine.snapshot());
  check('the new search is what is shown', ids(engine.snapshot().items).includes(video(8).id));
  check('and it is not stuck loading', engine.snapshot().loadingMore === false);
}

// 7. a failed page is retried and doesn't wedge the feed
{
  let attempt = 0;
  const { engine, calls } = make({
    pages: {
      0: { query: 'q', results: [video(1)], has_more: true, next_offset: 12 },
      12: () => (++attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ query: 'q', results: [video(3)], has_more: false, next_offset: 36 })),
    },
  });
  await engine.startSearch('q');
  await engine.loadMore();
  await tick();
  check('after a failure the feed is usable: not loading, still expecting more', engine.snapshot().loadingMore === false && engine.snapshot().hasMore === true, engine.snapshot());
  await engine.loadMore();
  await tick();
  check('the same page is requested again and succeeds', calls.filter((c) => c === 'search:q@12x24').length === 2 && ids(engine.snapshot().items).includes(video(3).id), calls);
}

// 8. cached feed first, then live results continue it
{
  const { engine, calls } = make({
    cachedPages: [{ videos: [video(3), video(4)], has_more: false }],
    pages: { 0: { query: 'rwanda', results: [video(4), video(5)], has_more: true, next_offset: 24 } },
  });
  engine.startCached([video(1), video(2)], true, 'rwanda');
  check('cached mode reports more (cache then live)', engine.snapshot().hasMore === true && engine.mode === 'cached');
  await engine.loadMore();
  check('load-more uses the cached pages first, at the cached offset', calls[0] === 'cached@2x24', calls);
  check('and adds them', JSON.stringify(ids(engine.snapshot().items)) === JSON.stringify([1, 2, 3, 4].map((n) => video(n).id)), engine.snapshot());
  await engine.loadMore();
  await tick();
  check('once the cache is exhausted it continues with live results from offset 0 of the default query', calls[1] === 'search:rwanda@0x24', calls);
  check('dropping videos the cache already showed', JSON.stringify(ids(engine.snapshot().items)) === JSON.stringify([1, 2, 3, 4, 5].map((n) => video(n).id)), engine.snapshot());
}

// 9. an empty cached page ends the cached feed even if the server claims more
{
  const { engine } = make({ cachedPages: [{ videos: [], has_more: true }], pages: { 0: { query: 'q', results: [], has_more: false, next_offset: 24 } } });
  engine.startCached([video(1)], true, 'q');
  await engine.loadMore();
  await tick();
  await engine.loadMore();
  await tick();
  check('an empty cached page cannot loop forever', engine.snapshot().hasMore === false && engine.snapshot().loadingMore === false, engine.snapshot());
}

// 10. a failing first page leaves the previous list in place (pull-to-refresh offline)
{
  const { engine } = make({ pages: { 0: new Error('offline') } });
  engine.startCached([video(1), video(2)], false, 'q');
  let threw = false;
  try {
    await engine.startSearch('q', true);
  } catch {
    threw = true;
  }
  check('a failed refresh throws for the screen to report', threw);
  check('and the previous list is untouched', ids(engine.snapshot().items).length === 2, engine.snapshot());
}

// 11. refresh flag is passed for the first page only
{
  const { engine, calls } = make({ pages: { 0: { query: 'q', results: [video(1)], has_more: false, next_offset: 12 } } });
  await engine.startSearch('q', true);
  check('a refresh asks the server to skip its cached copy', calls[0] === 'search:q@0x12:refresh', calls);
}

// 12. listeners are told about changes
{
  const { engine, changes } = make({ pages: { 0: { query: 'q', results: [video(1)], has_more: true, next_offset: 12 }, 12: { query: 'q', results: [video(2)], has_more: false, next_offset: 36 } } });
  await engine.startSearch('q');
  const afterStart = changes();
  await engine.loadMore();
  await tick();
  check('the screen is notified on start and around a load', afterStart >= 1 && changes() > afterStart, [afterStart, changes()]);
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
