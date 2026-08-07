// Bundle the two runtime workers (copc.js + laz-perf + proj4 + our encoders)
// into single ESM files, copy the laz-perf wasm next to them — the Service
// Worker resolves the wasm relative to its own URL and passes that on to the
// decode workers, so all three must stay siblings — and emit the third-party
// notices for whatever ended up inside those bundles.
//
//   node scripts/build-sw.mjs [outdir...]     (default: public)
//
// Run in the container:  docker compose run --rm web npm run build:sw
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { writeNotices } from './notices.mjs';

const outDirs = process.argv.slice(2);
if (outDirs.length === 0) outDirs.push('public');

// copc.js references Node built-ins (fs) on code paths we never hit in the SW
// (we pass our own HTTP Getter). Stub them so a browser bundle resolves.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(b) {
    b.onResolve({ filter: /^(fs|path|os|crypto|stream|util|zlib|http|https|url|buffer|events)$/ }, (a) => ({
      path: a.path,
      namespace: 'stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {}; export const promises = {};',
    }));
  },
};

const BUNDLES = [
  ['src/sw/sw.ts', 'pointstream3d-sw.js'],
  ['src/worker/decodeWorker.ts', 'pointstream3d-worker.js'],
];

const self = JSON.parse(readFileSync('package.json', 'utf8'));

for (const outDir of outDirs) {
  mkdirSync(outDir, { recursive: true });
  const metafiles = [];
  for (const [entry, outfile] of BUNDLES) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      outfile: `${outDir}/${outfile}`,
      plugins: [stubNodeBuiltins],
      metafile: true,
      logLevel: 'info',
    });
    metafiles.push(result.metafile);
  }
  copyFileSync('node_modules/laz-perf/lib/web/laz-perf.wasm', `${outDir}/laz-perf.wasm`);
  const notices = writeNotices(outDir, metafiles, self);
  console.log(
    `bundled -> ${outDir}/{${BUNDLES.map(([, f]) => f).join(',')}} ; wasm -> ${outDir}/laz-perf.wasm ; notices -> ${notices}`,
  );
}
