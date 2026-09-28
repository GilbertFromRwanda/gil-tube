// Tests the web UI's "Auto" download quality logic (web/index.html): the code
// is cut out of the page itself, so this tests what ships. Mirrors
// mobile/scripts/test-autoformat.mjs - keep the two in step.
//   node scripts/test-web-autoformat.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8');
const start = html.indexOf('// ---- Auto quality');
const end = html.indexOf('// ---- end auto quality');
if (start < 0 || end < 0) throw new Error('could not find the auto-quality code in web/index.html');
const code = html.slice(start, end);

const results = [];
const check = (name, cond, extra) => {
  results.push(cond);
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};

// video-only entries like YouTube's, plus an audio-only one
const v = (id, height, container = 'mp4', filesize = null, audio = null) => ({
  id, height, container, filesize, audio_codec: audio, video_codec: 'avc1', url: 'https://x/' + id,
});
const ladder = [v('160', 144), v('133', 240), v('134', 360), v('135', 480), v('136', 720), v('137', 1080), v('271', 1440, 'webm'), v('313', 2160, 'webm')];
const audioOnly = { id: '140', height: null, container: 'm4a', audio_codec: 'mp4a', filesize: 3_000_000, url: 'https://x/140' };

// Evaluates the extracted code with a fake `formatSelect`/`formatHint`/etc. (only
// what the block itself touches: `formatSelect.addEventListener`) and returns the
// pure functions the tests need.
function sandbox() {
  const scope = {
    formatSelect: { value: '', addEventListener() {} },
    formatHint: { classList: { add() {}, remove() {} }, textContent: '' },
    formatLabel: (f) => `${f.height || 'audio'}p`,
    API_BASE: 'http://api',
  };
  const factory = new Function(
    'scope',
    `with (scope) {
       ${code}
       return { AUTO_FORMAT, chooseFormat, estimateMbps, formatMbps, mbpsFrom, createSpeedMeter, SPEED_HEADROOM };
     }`,
  );
  return factory(scope);
}

const { AUTO_FORMAT, chooseFormat, estimateMbps, formatMbps, mbpsFrom, createSpeedMeter, SPEED_HEADROOM } = sandbox();
const pickH = (formats, mbps, dur) => chooseFormat(formats, mbps, dur)?.format.height;

check('AUTO_FORMAT is a value that can never be a real format id', typeof AUTO_FORMAT === 'string' && AUTO_FORMAT.startsWith('__'));

// 1. speed -> resolution (no file sizes: typical bitrates)
check('a fast connection (20 Mbps) picks 1080p', pickH(ladder, 20, 600) === 1080, pickH(ladder, 20, 600));
check('a very fast one (100 Mbps) picks 2160p', pickH(ladder, 100, 600) === 2160);
check('a middling one (5 Mbps) picks 480p', pickH(ladder, 5, 600) === 480, pickH(ladder, 5, 600));
check('a slow one (1 Mbps) picks the smallest, not nothing', pickH(ladder, 1, 600) === 144, pickH(ladder, 1, 600));
check('quality never goes down as speed goes up', [0.5, 1, 2, 4, 6, 10, 20, 50, 200].map((m) => pickH(ladder, m, 600)).every((h, i, a) => i === 0 || h >= a[i - 1]));

// 2. real file sizes beat the typical bitrates
{
  const odd = [v('a', 720, 'mp4', 400e6), v('b', 1080, 'mp4', 60e6), v('c', 360, 'mp4', 20e6)];
  check('uses the actual size: 1080p (60 MB) is taken over 720p (400 MB) at 5 Mbps', pickH(odd, 5, 600) === 1080, pickH(odd, 5, 600));
}

// 3. what counts
check('audio-only formats are never chosen', chooseFormat([audioOnly, ...ladder], 50, 600).format.id !== '140');
check('only audio formats: nothing to choose', chooseFormat([audioOnly], 50, 600) === null);
check('no formats: nothing to choose', chooseFormat([], 50, 600) === null);
check('mp4 preferred over webm at the same height', chooseFormat([v('w', 720, 'webm'), v('m', 720, 'mp4')], 50, 600).format.id === 'm');
check('at equal container the larger file wins', chooseFormat([v('s', 720, 'mp4', 10e6), v('l', 720, 'mp4', 20e6)], 50, 600).format.id === 'l');

// 4. unknown speed means "no opinion"
for (const bad of [null, undefined, 0, -3, NaN, Infinity]) {
  check(`speed ${bad} gives no pick`, chooseFormat(ladder, bad, 600) === null, bad);
}

// 5. estimates and budget
{
  const muxed = v('18', 360, 'mp4', null, 'mp4a');
  check('a muxed format does not add the audio track again', estimateMbps(muxed, 100) < estimateMbps(v('134', 360), 100));
  check('the budget is the measured speed times the headroom', chooseFormat(ladder, 10, 600).budgetMbps === 10 * SPEED_HEADROOM);
}

// 6. converting a timing to Mbit/s, and display
check('1 MB in 1 s is 8 Mbit/s', mbpsFrom(1_000_000, 1000) === 8);
check('unusable timings give null', mbpsFrom(0, 100) === null && mbpsFrom(100, 0) === null);
check('speeds are shown readably', formatMbps(0.84) === '0.8 Mbps' && formatMbps(12.4) === '12 Mbps' && formatMbps(150) === '150 Mbps');

// 7. the speed meter
{
  let clock = 0;
  let tests = 0;
  const meter = createSpeedMeter(async () => { tests += 1; return { bytes: 1_000_000, ms: 1000 }; }, () => clock, 1000);
  const [a, b] = await Promise.all([meter.get(), meter.get()]);
  check('two callers at once share one test', tests === 1 && a === 8 && b === 8, [tests, a, b]);
  await meter.get();
  check('a recent result is reused', tests === 1);
  clock = 1500;
  await meter.get();
  check('an old result is measured again', tests === 2);
}
{
  const failing = createSpeedMeter(async () => { throw new Error('offline'); });
  check('a failed test reports null instead of throwing', (await failing.get()) === null && failing.last() === null);
}

console.log(results.every(Boolean) ? `\nALL ${results.length} PASSED` : '\nFAILURES');
process.exit(results.every(Boolean) ? 0 : 1);
