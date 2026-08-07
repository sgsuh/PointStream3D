// Verifies the decode pool end to end:
//   1. tiles are decoded in the worker pool, not on the Service Worker thread;
//   2. after the browser stops an idle Service Worker, the restarted one gets
//      its MessagePorts handed over again and goes back to using the pool.
//
// (2) is the one failure mode the design has to handle: a Service Worker may be
// stopped at any time and comes back with no ports, since ports cannot be
// persisted. The first tile after a restart is decoded inline while the page
// re-handshakes.
//
//   docker run --rm --network pointstream3d_default \
//     -e TARGET_URL="http://web:5173/tiles.html" \
//     -v "$PWD/scripts:/home/pptruser/work:ro" -w /home/pptruser/work \
//     --entrypoint node ghcr.io/puppeteer/puppeteer:latest smoke-pool.mjs
import puppeteer from 'puppeteer';

const TARGET = process.env.TARGET_URL || 'http://web:5173/tiles.html';
const origin = new URL(TARGET).origin;

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1280,800',
    `--unsafely-treat-insecure-origin-as-secure=${origin}`,
    '--user-data-dir=/tmp/cdp-pool-profile',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => /^Done|^ERROR/.test(document.getElementById('status')?.textContent || ''), {
  timeout: Number(process.env.WAIT_MS || 180000),
  polling: 500,
});

const tilesetUrl = await page.evaluate(() => window.ps3dStats?.().tilesetUrl);
const statsUrl = new URL('stats.json', tilesetUrl).href;
const readStats = () => page.evaluate((u) => fetch(u).then((r) => r.json()), statsUrl);

// Collect a few tile URLs from the generated tileset so we can drive the Service
// Worker directly, without depending on camera motion.
const tileUrls = await page.evaluate(async (u) => {
  const doc = await (await fetch(u)).json();
  const found = [];
  const walk = (tile) => {
    const uri = tile.content?.uri;
    if (uri?.includes('.pnts')) found.push(new URL(uri, u).href);
    for (const child of tile.children ?? []) walk(child);
  };
  walk(doc.root);
  return found.slice(0, 4);
}, tilesetUrl);

const before = await readStats();
console.log('after initial load:', JSON.stringify(before));
check(before.poolSize > 0, `Service Worker holds ${before.poolSize} pool ports`);
check(before.poolDecodes > 0, `${before.poolDecodes} tiles decoded in the pool`);
check(before.inlineDecodes === 0, `no tiles decoded on the Service Worker thread`);
check(before.fallbacks === 0, 'no worker failures fell back inline');
check(tileUrls.length >= 2, `found ${tileUrls.length} tile URLs to replay`);

// --- Service Worker restart -------------------------------------------------

// Stopping the worker's target is how the browser itself retires an idle one:
// the registration stays, and the next fetch event starts a fresh instance.
const cdp = await browser.target().createCDPSession();
const { targetInfos } = await cdp.send('Target.getTargets');
const swTarget = targetInfos.find((t) => t.type === 'service_worker');
check(Boolean(swTarget), 'found the Service Worker target');
await cdp.send('Target.closeTarget', { targetId: swTarget.targetId });
console.log('\nstopped the Service Worker');

const fetchTile = (url) => page.evaluate(async (u) => (await fetch(u)).status, url);

// The restarted worker has no ports: this tile is decoded inline, and asks the
// page to hand them over again.
check((await fetchTile(tileUrls[0])) === 200, 'tile served while the pool is being re-attached');
const afterRestart = await readStats();
console.log('immediately after restart:', JSON.stringify(afterRestart));
check(
  afterRestart.poolDecodes === 0 && afterRestart.inlineDecodes === 1,
  'restarted worker started from a clean slate and decoded inline',
);

await new Promise((r) => setTimeout(r, 1000)); // let the re-handshake land

check((await fetchTile(tileUrls[1])) === 200, 'tile served after the pool is re-attached');
const recovered = await readStats();
console.log('after re-handshake:', JSON.stringify(recovered));
check(recovered.poolSize > 0, `ports handed over again (${recovered.poolSize})`);
check(recovered.poolDecodes >= 1, 'decoding went back to the pool');
check(recovered.fallbacks === 0, 'no fallbacks after recovery');

await browser.close();

console.log(failures.length ? `\nPOOL SMOKE FAILED (${failures.length})` : '\nPOOL SMOKE OK');
process.exit(failures.length ? 1 : 0);
