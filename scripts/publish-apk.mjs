// Publishes finished EAS Android builds into web/app/ with a version in every
// file name, plus a manifest (versions.json) the web UI reads to offer the
// newest build - and older ones - for download.
//
//   node scripts/publish-apk.mjs                # newest finished build
//   node scripts/publish-apk.mjs --count 3      # the 3 newest
//   node scripts/publish-apk.mjs --keep 5       # keep 5 builds on disk (default 3)
//
// File name:  GilTube-v<version>-b<build number>-<commit>.apk
// The build number is Android's versionCode, which EAS increments on every
// preview build (eas.json: autoIncrement). The commit keeps names unique even
// for builds made before numbering was turned on.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'web', 'app');
const manifestPath = join(outDir, 'versions.json');

function argNumber(flag, fallback) {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const count = argNumber('--count', 1);
const keep = Math.max(argNumber('--keep', 3), count);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function listBuilds() {
  let raw;
  try {
    // One command string (run through the shell) because eas is a .cmd shim on
    // Windows, which can't be spawned directly.
    raw = execSync('eas build:list --platform android --status finished --limit 20 --json --non-interactive', {
      cwd: join(root, 'mobile'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    fail(`Could not list builds. Is eas-cli installed and are you logged in (eas login)?\n${err.message}`);
  }
  const start = raw.indexOf('[');
  if (start < 0) fail('eas returned no build list.');
  return JSON.parse(raw.slice(start));
}

function readManifest() {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return Array.isArray(parsed.builds) ? parsed.builds : [];
  } catch {
    return [];
  }
}

function writeManifest(builds) {
  const tmp = `${manifestPath}.part`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), builds }, null, 2) + '\n');
  renameSync(tmp, manifestPath);
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, target) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let seen = 0;
  let lastPrint = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    seen += chunk.length;
    const now = Date.now();
    if (process.stdout.isTTY && total && now - lastPrint > 500) {
      lastPrint = now;
      process.stdout.write(`\r    ${(seen / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
    }
  });
  await pipeline(source, createWriteStream(target));
  if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(40) + '\r');
}

mkdirSync(outDir, { recursive: true });

const finished = listBuilds()
  .filter((b) => b.buildProfile === 'preview' && b.artifacts && b.artifacts.buildUrl)
  .slice(0, count);
if (finished.length === 0) {
  fail('No finished preview build with an APK was found. Start one with ./build-apk.sh');
}

const manifest = readManifest();

// Oldest first, so the newest ends up first once sorted below.
for (const build of finished.reverse()) {
  const commit = (build.gitCommitHash || '').slice(0, 7) || 'nocommit';
  const file = `GilTube-v${build.appVersion}-b${build.appBuildVersion}-${commit}.apk`;
  const target = join(outDir, file);

  if (manifest.some((m) => m.buildId === build.id) && existsSync(target)) {
    console.log(`==> ${file} is already published`);
    continue;
  }

  console.log(`==> Downloading ${file} (built ${build.completedAt})`);
  const part = `${target}.part`;
  try {
    await download(build.artifacts.buildUrl, part);
  } catch (err) {
    rmSync(part, { force: true });
    fail(`Download failed, nothing was replaced: ${err.message}`);
  }
  renameSync(part, target);

  const entry = {
    buildId: build.id,
    file,
    version: build.appVersion,
    build: build.appBuildVersion,
    commit,
    builtAt: build.completedAt,
    size: statSync(target).size,
    sha256: await sha256(target),
  };
  const existing = manifest.findIndex((m) => m.buildId === build.id);
  if (existing >= 0) manifest.splice(existing, 1);
  manifest.push(entry);
}

manifest.sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));

// Keep the newest few on disk (each is ~100 MB).
for (const old of manifest.splice(keep)) {
  rmSync(join(outDir, old.file), { force: true });
  console.log(`==> Removed old build ${old.file}`);
}

writeManifest(manifest);

const latest = manifest[0];
console.log(`==> Done. Latest: ${latest.file}  (${(latest.size / 1048576).toFixed(0)} MB, sha256 ${latest.sha256.slice(0, 12)}…)`);
console.log(`    ${manifest.length} build(s) available. Open the web UI, click 📱, and scan the QR code.`);
