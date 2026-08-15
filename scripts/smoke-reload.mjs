// Verifies that a page going away does not leave dead decode ports behind.
//
// The workers belong to the page and die with it, but the Service Worker
// outlives it and holds one MessagePort per worker. A port to a dead worker
// still accepts postMessage and never answers, so every tile routed to one waits
// out DECODE_TIMEOUT_MS (60 s) before falling back to inline decoding. Two ways
// out, both checked here:
//   1. the page hands its ports back on `pagehide`;
//   2. the Service Worker sweeps ports whose client is gone when a new pool is
//      handed over — the only path left when a tab crashes and (1) never runs.
//
//   docker run --rm --network pointstream3d_default \
//     -e TARGET_URL="http://web:5173/tiles.html" \
//     -v "$PWD/scripts:/home/pptruser/work:ro" -w /home/pptruser/work \
//     --entrypoint node ghcr.io/puppeteer/puppeteer:latest smoke-reload.mjs
import puppeteer from 'puppeteer';

const TARGET = process.env.TARGET_URL || 'http://web:5173/tiles.html';
const WAIT_MS = Number(process.env.WAIT_MS || 180000);
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
    '--user-data-dir=/tmp/cdp-reload-profile',
  ],
});

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

// A load blocked on dead ports pays DECODE_TIMEOUT_MS before it can fall back,
// and the timeouts overlap, so it lands ~60 s late however many ports are stale.
// Well clear of a healthy load (~20 s headless) and of one dead-port wait.
const SLOW_LOAD_MS = 45000;

const ONLY = process.env.ONLY || '';
const wanted = (name) => !ONLY || ONLY === name;

let settleMs = 0;
const settled = async (page) => {
  const started = Date.now();
  await page.waitForFunction(
    () => /^Done|^ERROR/.test(document.getElementById('status')?.textContent || ''),
    { timeout: WAIT_MS, polling: 500 },
  );
  settleMs = Date.now() - started;
};

async function open() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
  await settled(page);
  return page;
}

const statsOf = async (page) => {
  const tilesetUrl = await page.evaluate(() => window.ps3dStats?.().tilesetUrl);
  return page.evaluate((u) => fetch(new URL('stats.json', u).href).then((r) => r.json()), tilesetUrl);
};

// --- 1. reload ---------------------------------------------------------------

let page = await open();
const first = await statsOf(page);
console.log('first load:      ', JSON.stringify(first), `(${settleMs} ms)`);
const N = first.poolSize;
check(N > 0, `Service Worker holds ${N} pool ports`);

if (wanted('reload')) {
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await settled(page);
  const reloaded = await statsOf(page);
  console.log('after reload:    ', JSON.stringify(reloaded), `(${settleMs} ms)`);
  check(
    reloaded.poolSize === N,
    `reload replaced the ports instead of stacking them (${reloaded.poolSize}, expected ${N})`,
  );
  check(settleMs < SLOW_LOAD_MS, `reload did not stall on a dead port (${settleMs} ms)`);
  check(reloaded.fallbacks === 0, 'no tile fell back inline after the reload');
  check(reloaded.inlineDecodes === 0, 'every tile after the reload was decoded in the pool');
}

// --- 2. crashed tab ----------------------------------------------------------

// A tab whose `pagehide` handover never lands — killed by the OS, or simply not
// delivered while the renderer is being torn down — is what the Service Worker's
// own sweep is for. Simulate it by stopping the page from registering the
// handler at all, which leaves exactly the state that case leaves behind.
//
// The first tab stays open throughout: when the last client goes away the
// browser retires the Service Worker, and a restarted one has no ports at all,
// so there would be nothing to leak. A surviving tab is what keeps the instance
// — and the dead tab's ports — alive. (Crashing a tab cannot be used here:
// same-site tabs share a renderer process, so it takes the survivor with it.)
if (wanted('crash')) {
  const victim = await browser.newPage();
  await victim.setViewport({ width: 1280, height: 800 });
  await victim.evaluateOnNewDocument(() => {
    const add = window.addEventListener.bind(window);
    window.addEventListener = (type, ...rest) => {
      if (type !== 'pagehide') add(type, ...rest);
    };
  });
  await victim.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
  await settled(victim);

  const beforeCrash = await statsOf(page);
  check(beforeCrash.poolSize === 2 * N, `two tabs hold ${2 * N} ports (${beforeCrash.poolSize})`);

  await victim.close();
  await new Promise((r) => setTimeout(r, 500));
  console.log('closed the second tab without handing its ports back');

  const after = await statsOf(await open());
  console.log('after close+load:', JSON.stringify(after), `(${settleMs} ms)`);
  // A Service Worker the browser retired in the meantime comes back with the
  // counters zeroed, so only diff them against the earlier reading if it is
  // still the same instance.
  const sameInstance = after.poolDecodes >= beforeCrash.poolDecodes;
  const newFallbacks = sameInstance ? after.fallbacks - beforeCrash.fallbacks : after.fallbacks;
  check(sameInstance, 'the Service Worker survived, so its ports were really at risk');
  check(
    after.poolSize === 2 * N,
    `ports of the departed tab were swept (${after.poolSize}, expected ${2 * N})`,
  );
  check(settleMs < SLOW_LOAD_MS, `load afterwards did not stall on a dead port (${settleMs} ms)`);
  check(newFallbacks === 0, `no tile fell back inline afterwards (${newFallbacks})`);
}

await browser.close();
console.log(failures.length ? `\nRELOAD SMOKE FAILED (${failures.length})` : '\nRELOAD SMOKE OK');
process.exit(failures.length ? 1 : 0);
