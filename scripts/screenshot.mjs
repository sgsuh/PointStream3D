// Headless render verification: loads the PoC page, waits for the status line
// to report Done/ERROR, captures console output, and screenshots the canvas.
// Run via the official puppeteer image (see scripts/verify-render.sh).
import puppeteer from 'puppeteer';

const TARGET = process.env.TARGET_URL || 'http://host.docker.internal:5173/';
const OUT = process.env.OUT || '/out/poc.png';

const origin = new URL(TARGET).origin;
const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--window-size=1280,800',
    // Service Workers require a secure context; whitelist the dev origin so
    // http://web:5173 (not localhost) still gets navigator.serviceWorker.
    `--unsafely-treat-insecure-origin-as-secure=${origin}`,
    '--user-data-dir=/tmp/cdp-profile',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// Tally COPC tile requests to prove lazy multi-chunk streaming. Distinct
// page-offsets > 1 proves real COPC sub-pages loaded (not just the root page).
const tally = { tileset: 0, page: 0, pnts: 0 };
const pageOffsets = new Set();
page.on('request', (r) => {
  const u = new URL(r.url());
  const p = u.pathname;
  if (p.endsWith('/tileset.json')) tally.tileset++;
  else if (p.endsWith('/page.json')) {
    tally.page++;
    pageOffsets.add(u.searchParams.get('o'));
  } else if (p.endsWith('.pnts')) tally.pnts++;
});

await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });

// Wait until the status line reports completion or an error.
let finalStatus = '(timeout)';
try {
  finalStatus = await page.waitForFunction(
    () => {
      const t = document.getElementById('status')?.textContent || '';
      return /^Done|^ERROR/.test(t) ? t : false;
    },
    { timeout: Number(process.env.WAIT_MS || 120000), polling: 500 },
  ).then((h) => h.jsonValue());
} catch {
  finalStatus = await page.$eval('#status', (e) => e.textContent).catch(() => '(no status)');
}

// Give the camera flight a moment to settle, then screenshot.
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: OUT });

console.log('=== TILE REQUESTS ===');
console.log(`tileset.json: ${tally.tileset}  page.json(external): ${tally.page}  pnts: ${tally.pnts}`);
console.log(`distinct COPC pages loaded (offsets): ${pageOffsets.size}  -> real sub-pages: ${pageOffsets.size > 1 ? 'YES' : 'no'}`);
console.log('=== FINAL STATUS ===');
console.log(finalStatus);
console.log('=== CONSOLE (last 25) ===');
console.log(logs.slice(-25).join('\n'));
console.log('=== screenshot ===', OUT);

await browser.close();
