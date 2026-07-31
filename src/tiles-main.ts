import {
  Viewer,
  Cesium3DTileset,
  Cartesian3,
  Cartographic,
  Color,
  HeadingPitchRange,
  Math as CesiumMath,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// COPC file to stream, configurable via query so we can test different files:
//   tiles.html?src=/remote-s3/hobu-lidar/sofi.copc.laz&zoom=0.15
const params = new URLSearchParams(location.search);
const SRC = params.get('src') ?? '/data/autzen.copc.laz';
const ZOOM = Number(params.get('zoom') ?? '0.9'); // camera range as a fraction of the bounding radius
const MAX_SSE = Number(params.get('sse') ?? '4');
// Explicit camera as "lon,lat,height,heading,pitch" (degrees/metres). Framing via
// zoomTo() depends on the root bounding volume, so LOD A/B runs must pin the
// camera instead — otherwise a bounding-volume change silently reframes the shot.
const CAM = params.get('cam');
// Tiles per external tileset; forwarded to the Service Worker.
const MAX_TILES = params.get('mt');
// Point-cloud shading and point budget, all overridable for A/B measurement.
const GEOMETRIC_ERROR_SCALE = Number(params.get('ges') ?? '1.5');
const MAX_ATTENUATION = Number(params.get('maxatt') ?? '8');
const EDL_STRENGTH = Number(params.get('edl') ?? '1.0');
const EDL_RADIUS = Number(params.get('edlr') ?? '1.0');
const CACHE_MB = Number(params.get('cache') ?? '512');
const DYNAMIC_SSE = params.get('dyn') === '1';

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
  const tilesetUrl =
    `/copc-tiles/tileset.json?src=${encodeURIComponent(SRC)}` +
    (MAX_TILES ? `&mt=${encodeURIComponent(MAX_TILES)}` : '');
  const tileset = await Cesium3DTileset.fromUrl(tilesetUrl, {
    maximumScreenSpaceError: MAX_SSE,
  });

  // The payoff of the 3D Tiles path: point-cloud shading comes from the engine.
  const shading = tileset.pointCloudShading;
  shading.attenuation = true;
  // Cesium sizes an attenuated point from the tile's geometricError, which we
  // emit as the true COPC spacing. Points are square splats over an irregular
  // distribution, so sizing them at exactly one spacing still leaves gaps —
  // scaling up slightly closes them and buys a coarser (cheaper) SSE at the same
  // perceived density.
  shading.geometricErrorScale = GEOMETRIC_ERROR_SCALE;
  // Pixel cap on that size, so a close-up doesn't turn into large blobs.
  shading.maximumAttenuation = MAX_ATTENUATION;
  shading.eyeDomeLighting = true;
  shading.eyeDomeLightingStrength = EDL_STRENGTH;
  shading.eyeDomeLightingRadius = EDL_RADIUS;

  // Point budget. Cesium evicts unselected tiles once the cache exceeds
  // cacheBytes, and hard-fails allocation past cacheBytes + overflow, so this is
  // the knob that bounds memory on an arbitrarily large COPC file.
  tileset.cacheBytes = CACHE_MB * 1024 * 1024;
  tileset.maximumCacheOverflowBytes = CACHE_MB * 1024 * 1024;
  // Relaxes SSE with distance in near-horizon views. Off by default: it made no
  // measurable difference on autzen at either an oblique or a horizon camera,
  // and it only starts paying off on datasets far larger than the view.
  tileset.dynamicScreenSpaceError = DYNAMIC_SSE;

  const addedAt = performance.now();
  viewer.scene.primitives.add(tileset);
  if (CAM) {
    const [lon, lat, height, heading, pitch] = CAM.split(',').map(Number);
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: CesiumMath.toRadians(heading),
        pitch: CesiumMath.toRadians(pitch),
        roll: 0,
      },
    });
  } else {
    // Frame closer (oblique) so refinement goes deep enough to cross chunk
    // boundaries and pull external tilesets — exercising the lazy path.
    await viewer.zoomTo(
      tileset,
      new HeadingPitchRange(0, -0.45, tileset.boundingSphere.radius * ZOOM),
    );
  }

  // LOD metrics for the headless harness: `selected`/`visited` are per-frame and
  // are refilled by every traversal, so read them live rather than snapshotting.
  let loadMs: number | null = null;
  Object.assign(window, {
    ps3dStats: () => {
      // `statistics` powers Cesium's own 3D Tiles inspector but is not in the
      // public typings; it is read-only telemetry, used here only by the
      // headless LOD harness.
      const s = (tileset as unknown as { statistics: Record<string, number | undefined> })
        .statistics;
      const cam = viewer.camera;
      const carto = Cartographic.fromCartesian(cam.positionWC);
      const r6 = (v: number) => Number(v.toFixed(6));
      return {
        loadMs,
        // Copy this into ?cam= to replay the exact framing in an A/B run.
        cam: [
          r6(CesiumMath.toDegrees(carto.longitude)),
          r6(CesiumMath.toDegrees(carto.latitude)),
          Math.round(carto.height),
          r6(CesiumMath.toDegrees(cam.heading)),
          r6(CesiumMath.toDegrees(cam.pitch)),
        ].join(','),
        rootBoundingRadius: Math.round(tileset.boundingSphere.radius),
        // Lets the harness weigh the chunk-size trade-off: fewer external
        // tilesets means fewer round trips but a larger root document.
        tilesetUrl,
        pointsSelected: s.numberOfPointsSelected ?? null,
        tilesSelected: s.selected ?? null,
        tilesVisited: s.visited ?? null,
        tilesLoaded: s.numberOfLoadedTilesTotal ?? null,
        tilesTotal: s.numberOfTilesTotal ?? null,
        tilesWithContentReady: s.numberOfTilesWithContentReady ?? null,
        geometryBytes: s.geometryByteLength ?? null,
        maximumScreenSpaceError: tileset.maximumScreenSpaceError,
        geometricErrorScale: GEOMETRIC_ERROR_SCALE,
        maximumAttenuation: MAX_ATTENUATION,
        dynamicScreenSpaceError: DYNAMIC_SSE,
      };
    },
  });

  tileset.allTilesLoaded.addEventListener(() => {
    if (loadMs === null) loadMs = Math.round(performance.now() - addedAt);
    setStatus('Done — COPC streamed to 3D Tiles via Service Worker. EDL + attenuation on.');
  });
  setStatus('Tileset added — streaming tiles…');
}

main().catch((e) => {
  console.error(e);
  setStatus('ERROR: ' + (e?.message ?? String(e)));
});
