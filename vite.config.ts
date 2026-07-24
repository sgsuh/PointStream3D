import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
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
});
