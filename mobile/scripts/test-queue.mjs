// Tests for next/previous (src/player/queue.ts) with a fake feed.
//   npm run test:queue
import { PlayQueue, RESTART_THRESHOLD_SECONDS } from '../src/player/queue.ts';

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};
const v = (n) => ({ id: `id${n}`, title: `T${n}`, url: `https://y/${n}`, thumbnail: null, duration: 60, uploader: 'u' });
const vids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => v(from + i));
const ids = (list) => list.map((x) => x.id);

// A feed that can grow: `pages` are appended one per loadMore().
function feed(initial, pages = []) {
  let items = initial.slice();
  let loads = 0;
  const source = {
    items: () => items,
    hasMore: () => loads < pages.length,
    loadMore: async () => {
      if (loads < pages.length) items = items.concat(pages[loads++]);
    },
  };
  return { source, replace: (list) => (items = list.slice()), loads: () => loads };
}

// 1. plain navigation inside the loaded list
{
  const f = feed(vids(1, 5));
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id2');
  check('next is the following item', (await q.next('id2')).id === 'id3');
  check('previous (at the start of a track) is the item before', q.prev('id2', 1).item.id === 'id1' && q.prev('id2', 1).restart === false);
  check('hasPrev / hasNext in the middle', q.hasPrev('id3') && q.hasNext('id3'));
}

// 2. previous restarts the track when you are past the threshold or at the very start
{
  const f = feed(vids(1, 3));
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id2');
  const late = q.prev('id2', RESTART_THRESHOLD_SECONDS + 0.5);
  check('previous more than 3s in restarts the current track', late.restart === true && late.item === null, late);
  const atThreshold = q.prev('id2', RESTART_THRESHOLD_SECONDS);
  check('previous at exactly 3s still goes back', atThreshold.restart === false && atThreshold.item.id === 'id1', atThreshold);
  q.adopt('id1');
  const first = q.prev('id1', 0.5);
  check('previous on the first track just restarts it', first.restart === true && first.item === null, first);
  check('and there is no previous to show', q.hasPrev('id1') === false);
}

// 3. running out of loaded items asks the feed for more
{
  const f = feed(vids(1, 3), [vids(4, 6), vids(7, 9)]);
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id3');
  check('at the end with more available, hasNext is true', q.hasNext('id3') === true);
  const n = await q.next('id3');
  check('next loads another page and returns its first video', n && n.id === 'id4' && f.loads() === 1, [n, f.loads()]);
  check('the queue now includes the new page', ids(q.items()).join() === ['id1', 'id2', 'id3', 'id4', 'id5', 'id6'].join(), ids(q.items()));
  q.adopt('id6');
  const m = await q.next('id6');
  check('and again at the end of that page', m && m.id === 'id7' && f.loads() === 2, [m, f.loads()]);
}

// 4. the true end
{
  const f = feed(vids(1, 2), []);
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id2');
  check('no more anywhere: hasNext is false', q.hasNext('id2') === false);
  check('and next is null', (await q.next('id2')) === null);
}

// 5. pages that add nothing don't loop forever
{
  const f = feed(vids(1, 2), [[], [], [], [], []]);
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id2');
  const n = await q.next('id2');
  check('empty pages: gives up after a few attempts with null', n === null && f.loads() <= 3, [n, f.loads()]);
}

// 6. the user searches for something else while a track plays
{
  const f = feed(vids(1, 4), [vids(5, 8)]);
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id2');                      // playing id2 from the first list
  f.replace(vids(101, 110));           // the screen now shows different results
  check('the queue keeps going through the list playback started from', (await q.next('id2')).id === 'id3');
  check('it does not jump into the new search results', !ids(q.items()).includes('id101'), ids(q.items()));
  check('and it can still go back', q.hasPrev('id3') === true);
  q.adopt('id4');
  const atEnd = await q.next('id4');
  check('at the end of the old list it stops rather than pulling from an unrelated feed', atEnd === null && f.loads() === 0, [atEnd, f.loads()]);
  check('so hasNext is false there', q.hasNext('id4') === false);
}

// 7. the feed grows while a track plays: the queue picks it up
{
  const f = feed(vids(1, 3), [vids(4, 6)]);
  const q = new PlayQueue();
  q.setSource(f.source);
  q.adopt('id3');
  await f.source.loadMore();           // the user scrolled and the feed loaded more
  check('items loaded by scrolling become part of the queue', (await q.next('id3')).id === 'id4');
}

// 8. unknown current video
{
  const f = feed(vids(1, 3));
  const q = new PlayQueue();
  q.setSource(f.source);
  check('a video that was never in the list has no next', (await q.next('nope')) === null && q.hasNext('nope') === false);
  check('and previous restarts', q.prev('nope', 0).restart === true);
}

// 9. no source at all
{
  const q = new PlayQueue();
  check('without a source everything is safely empty', q.hasNext('x') === false && q.hasPrev('x') === false && (await q.next('x')) === null);
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
