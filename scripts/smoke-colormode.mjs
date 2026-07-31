// Click through every colour mode the demo offers and assert that none of them
// refetches tile content — switching must only swap the GPU style. Run it the
// same way as screenshot.mjs, from the official Puppeteer image on the compose
// network:
//
//   docker run --rm --network pointstream3d_default \
//     -e TARGET_URL="http://web:5173/tiles.html" \
//     -v "$PWD/scripts:/home/pptruser/work:ro" \
//     -w /home/pptruser/work --entrypoint node \
//     ghcr.io/puppeteer/puppeteer:latest smoke-colormode.mjs
import puppeteer from 'puppeteer';

const TARGET = process.env.TARGET_URL;
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
    '--user-data-dir=/tmp/cdp-profile',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

let pnts = 0;
page.on('request', (r) => {
  if (new URL(r.url()).pathname.endsWith('.pnts')) pnts++;
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => /^Done|^ERROR/.test(document.getElementById('status')?.textContent || ''), {
  timeout: 180000,
  polling: 500,
});
await new Promise((r) => setTimeout(r, 3000));

const before = pnts;
const modes = await page.evaluate(() =>
  [...document.querySelectorAll('#colorModes button')].map((b) => b.textContent),
);

// Click through every mode and let each settle.
for (const mode of modes) {
  await page.evaluate((m) => {
    [...document.querySelectorAll('#colorModes button')].find((b) => b.textContent === m)?.click();
  }, mode);
  await new Promise((r) => setTimeout(r, 1500));
}
const after = pnts;

const active = await page.evaluate(() => window.ps3dStats().colorMode);
console.log(`modes offered      : ${modes.join(', ')}`);
console.log(`pnts before switch : ${before}`);
console.log(`pnts after  switch : ${after}`);
console.log(`refetched tiles    : ${after - before}`);
console.log(`active mode        : ${active}`);
console.log(`page errors        : ${errors.length ? errors.join(' | ') : 'none'}`);
console.log(after === before && errors.length === 0 ? 'SWITCH OK (no refetch)' : 'SWITCH FAILED');

await browser.close();
