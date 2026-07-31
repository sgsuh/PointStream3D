import { defineConfig } from 'vite';

// Library build. The client half of PointStream3D only talks to Cesium — copc,
// laz-perf and proj4 live entirely inside the Service Worker bundle, which is
// produced separately by scripts/build-sw.mjs into the same directory.
export default defineConfig({
  // Vite would otherwise copy public/ — including the multi-megabyte COPC
  // samples — into the published package.
  publicDir: false,
  build: {
    outDir: 'dist',
    // The Service Worker and wasm are emitted into dist too; don't wipe them.
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'pointstream3d.js',
    },
    rollupOptions: {
      external: ['cesium'],
    },
  },
});
