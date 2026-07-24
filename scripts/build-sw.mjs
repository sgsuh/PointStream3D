// Bundle the Service Worker (copc.js + laz-perf + proj4 + our encoders) into a
// single ESM file at public/copc-sw.js, and copy the laz-perf wasm next to it.
// Run in the container:  docker compose run --rm web npm run build:sw
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';

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

await build({
  entryPoints: ['src/sw/sw.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: 'public/copc-sw.js',
  plugins: [stubNodeBuiltins],
  logLevel: 'info',
});

copyFileSync('node_modules/laz-perf/lib/web/laz-perf.wasm', 'public/laz-perf.wasm');
console.log('SW bundled -> public/copc-sw.js ; wasm -> public/laz-perf.wasm');
