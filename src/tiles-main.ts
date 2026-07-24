import { Viewer, Cesium3DTileset, Color, HeadingPitchRange } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// COPC file to stream, configurable via query so we can test different files:
//   tiles.html?src=/remote-s3/hobu-lidar/sofi.copc.laz&zoom=0.15
const params = new URLSearchParams(location.search);
const SRC = params.get('src') ?? '/data/autzen.copc.laz';
const ZOOM = Number(params.get('zoom') ?? '0.9'); // camera range as a fraction of the bounding radius
const MAX_SSE = Number(params.get('sse') ?? '4');

const statusEl = document.getElementById('status')!;
const setStatus = (m: string) => {
  statusEl.textContent = m;
  console.log('[PointStream3D/tiles]', m);
};

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('Service Workers unavailable');
  await navigator.serviceWorker.register('/copc-sw.js', { type: 'module' });
  await navigator.serviceWorker.ready;
  // With skipWaiting + clients.claim the SW controls this page immediately;
  // wait for the controller if it hasn't landed yet.
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  }
}

async function main() {
  const viewer = new Viewer('cesiumContainer', {
    baseLayer: false as unknown as undefined,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });
  viewer.scene.backgroundColor = Color.fromCssColorString('#0b1021');

  setStatus('Registering Service Worker…');
  await registerServiceWorker();

  setStatus('Loading tileset (COPC → 3D Tiles via Service Worker)…');
  const tileset = await Cesium3DTileset.fromUrl(
    `/copc-tiles/tileset.json?src=${encodeURIComponent(SRC)}`,
    { maximumScreenSpaceError: MAX_SSE },
  );

  // The payoff of the 3D Tiles path: point-cloud shading comes from the engine.
  tileset.pointCloudShading.attenuation = true;
  tileset.pointCloudShading.eyeDomeLighting = true;
  tileset.pointCloudShading.eyeDomeLightingStrength = 1.0;
  tileset.pointCloudShading.eyeDomeLightingRadius = 1.0;

  viewer.scene.primitives.add(tileset);
  // Frame closer (oblique) so refinement goes deep enough to cross chunk
  // boundaries and pull external tilesets — exercising the lazy path.
  await viewer.zoomTo(
    tileset,
    new HeadingPitchRange(0, -0.45, tileset.boundingSphere.radius * ZOOM),
  );

  tileset.allTilesLoaded.addEventListener(() => {
    setStatus('Done — COPC streamed to 3D Tiles via Service Worker. EDL + attenuation on.');
  });
  setStatus('Tileset added — streaming tiles…');
}

main().catch((e) => {
  console.error(e);
  setStatus('ERROR: ' + (e?.message ?? String(e)));
});
