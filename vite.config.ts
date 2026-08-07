import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import cesium from 'vite-plugin-cesium';

// Runtime assets the demo needs out of public/. Everything else there — notably
// the multi-megabyte COPC samples in public/data — must not reach the published
// site, so the build turns publicDir off and copies just these.
const RUNTIME_ASSETS = [
  'pointstream3d-sw.js',
  'pointstream3d-worker.js',
  'laz-perf.wasm',
  'THIRD-PARTY-NOTICES.txt',
];

// No build ships the samples, so every build has to point somewhere that exists.
// This bucket serves COPC over HTTP range with `Access-Control-Allow-Origin: *`,
// which is the whole requirement — the library streams it as-is. The dev server
// keeps using the local copy in public/data.
const DEMO_SRC = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

function copyRuntimeAssets(): Plugin {
  let outDir = 'dist-demo';
  let base = '/';
  return {
    name: 'pointstream3d-runtime-assets',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      base = config.base;
    },
    // closeBundle is a parallel hook, and vite-plugin-cesium copies its assets
    // there asynchronously — run last, and only once everyone else has finished,
    // or there is nothing to lift yet.
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        for (const file of RUNTIME_ASSETS) copyFileSync(`public/${file}`, `${outDir}/${file}`);
        unnestBase(outDir, base);
      },
    },
  };
}

/**
 * vite-plugin-cesium copies Cesium's assets to `<outDir><base>/cesium`, but
 * outDir *is* what gets served at `base` — so under `--base=/PointStream3D/`
 * they land one directory too deep and every `/PointStream3D/cesium/...` request
 * 404s. The emitted URLs are right; only the paths on disk are wrong. Lift them.
 */
function unnestBase(outDir: string, base: string): void {
  const segments = base.split('/').filter(Boolean);
  if (!segments.length) return;
  const nested = `${outDir}/${segments.join('/')}`;
  if (!existsSync(nested)) return;
  for (const entry of readdirSync(nested)) renameSync(`${nested}/${entry}`, `${outDir}/${entry}`);
  rmSync(`${outDir}/${segments[0]}`, { recursive: true, force: true });
}

// Dev server and demo-site build. The library itself is built by
// vite.lib.config.ts — this config only covers the two demo pages.
export default defineConfig(({ command }) => ({
  plugins: [cesium(), copyRuntimeAssets()],
  // Serve everything in public/ during development, including the samples;
  // publish only RUNTIME_ASSETS.
  publicDir: command === 'build' ? false : 'public',
  define:
    command === 'build'
      ? {
          'import.meta.env.VITE_DEMO_SRC': JSON.stringify(process.env.VITE_DEMO_SRC ?? DEMO_SRC),
        }
      : {},
  build: {
    // Kept out of dist/, which is the publishable package.
    outDir: 'dist-demo',
    rollupOptions: {
      // tiles.html is the real demo; index.html is the PointPrimitiveCollection
      // PoC that proved the data pipeline.
      input: { index: 'index.html', tiles: 'tiles.html' },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow access via container/service hostnames (e.g. `web`, host.docker.internal)
    // — Vite's default host check otherwise 403s cross-container requests.
    allowedHosts: true,
    // Polling makes HMR reliable for bind mounts inside Docker on WSL2.
    watch: { usePolling: true },
    // Proxy remote COPC files as same-origin (forwards Range requests) so the
    // browser/SW can stream them without CORS or downloading the whole file.
    //   /remote-s3/hobu-lidar/sofi.copc.laz -> https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz
    proxy: {
      '/remote-s3': {
        target: 'https://s3.amazonaws.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/remote-s3/, ''),
      },
    },
  },
}));
