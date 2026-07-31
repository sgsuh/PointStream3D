// Bundle the Service Worker (copc.js + laz-perf + proj4 + our encoders) into a
// single ESM file, and copy the laz-perf wasm next to it — the worker resolves
// the wasm relative to its own URL, so the two must stay siblings.
//
//   node scripts/build-sw.mjs [outdir...]     (default: public)
//
// Run in the container:  docker compose run --rm web npm run build:sw
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

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

for (const outDir of outDirs) {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: ['src/sw/sw.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    outfile: `${outDir}/pointstream3d-sw.js`,
    plugins: [stubNodeBuiltins],
    logLevel: 'info',
  });
  copyFileSync('node_modules/laz-perf/lib/web/laz-perf.wasm', `${outDir}/laz-perf.wasm`);
  console.log(`SW bundled -> ${outDir}/pointstream3d-sw.js ; wasm -> ${outDir}/laz-perf.wasm`);
}
