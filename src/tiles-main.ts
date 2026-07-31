// Demo app for the PointStream3D library. It uses nothing but the public API,
// so it doubles as a check that the API is actually sufficient.
import {
  Viewer,
  Cartesian3,
  Cartographic,
  Color,
  HeadingPitchRange,
  Math as CesiumMath,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { COPCPointCloud, COPC_DEFAULTS, type COPCColorMode } from './index';

const COLOR_MODES: COPCColorMode[] = ['rgb', 'elevation', 'intensity', 'classification'];

// Everything is query-configurable so the headless harness can A/B one knob at
// a time:  tiles.html?src=/remote-s3/hobu-lidar/sofi.copc.laz&sse=8
const params = new URLSearchParams(location.search);
// Relative, so the demo also works when served under a base path; the library
// resolves it against the document base.
const SRC = params.get('src') ?? 'data/autzen.copc.laz';
const ZOOM = Number(params.get('zoom') ?? '0.9'); // camera range as a fraction of the bounding radius
const MAX_SSE = Number(params.get('sse') ?? String(COPC_DEFAULTS.maximumScreenSpaceError));
// Explicit camera as "lon,lat,height,heading,pitch" (degrees/metres). Framing via
// zoomTo() depends on the root bounding volume, so LOD A/B runs must pin the
// camera instead — otherwise a bounding-volume change silently reframes the shot.
const CAM = params.get('cam');
const COLOR = params.get('color') as COPCColorMode | null;
const num = (key: string, fallback: number) => Number(params.get(key) ?? String(fallback));

const statusEl = document.getElementById('status')!;
const setStatus = (m: string) => {
  statusEl.textContent = m;
  console.log('[PointStream3D/tiles]', m);
};

// Runtime colour switching: assigning colorMode only swaps the GPU style, so no
// tile is refetched. `rgb` is offered only when the file actually has colour.
function buildColorSwitcher(cloud: COPCPointCloud): void {
  const host = document.getElementById('colorModes')!;
  const buttons = new Map<COPCColorMode, HTMLButtonElement>();
  const refresh = () => {
    for (const [mode, button] of buttons) {
      button.classList.toggle('active', cloud.colorMode === mode);
    }
  };
  for (const mode of COLOR_MODES) {
    if (mode === 'rgb' && cloud.hasColor === false) continue;
    const button = document.createElement('button');
    button.textContent = mode;
    button.onclick = () => {
      cloud.colorMode = mode;
      refresh();
    };
    buttons.set(mode, button);
    host.appendChild(button);
  }
  refresh();
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

  setStatus('Loading COPC (Service Worker → 3D Tiles)…');
  const addedAt = performance.now();
  const cloud = await COPCPointCloud.fromUrl(SRC, {
    // serviceWorker.url is left at its default — `pointstream3d-sw.js` next to
    // the document base — which is what makes this work under a base path too.
    maximumScreenSpaceError: MAX_SSE,
    ...(COLOR ? { colorMode: COLOR } : {}),
    // Carry every attribute so the switcher can change mode without refetching.
    // `?attrs=0` drops them, for measuring what that costs.
    attributes: params.get('attrs') === '0' ? [] : ['intensity', 'classification', 'height'],
    maxTilesPerChunk: num('mt', COPC_DEFAULTS.maxTilesPerChunk),
    cacheBytes: num('cache', COPC_DEFAULTS.cacheBytes / (1024 * 1024)) * 1024 * 1024,
    dynamicScreenSpaceError: params.get('dyn') === '1',
    pointCloudShading: {
      geometricErrorScale: num('ges', COPC_DEFAULTS.pointCloudShading.geometricErrorScale),
      maximumAttenuation: num('maxatt', COPC_DEFAULTS.pointCloudShading.maximumAttenuation),
      eyeDomeLightingStrength: num('edl', COPC_DEFAULTS.pointCloudShading.eyeDomeLightingStrength),
      eyeDomeLightingRadius: num('edlr', COPC_DEFAULTS.pointCloudShading.eyeDomeLightingRadius),
    },
  });

  const { tileset } = cloud;
  viewer.scene.primitives.add(tileset);
  buildColorSwitcher(cloud);
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
    // Frame obliquely and close enough that refinement crosses chunk boundaries
    // and pulls external tilesets — exercising the lazy path.
    await viewer.zoomTo(tileset, new HeadingPitchRange(0, -0.45, cloud.boundingSphere.radius * ZOOM));
  }

  // LOD metrics for the headless harness: `selected`/`visited` are per-frame and
  // are refilled by every traversal, so read them live rather than snapshotting.
  let loadMs: number | null = null;
  Object.assign(window, {
    ps3dStats: () => {
      // `statistics` powers Cesium's own 3D Tiles inspector but is not in the
      // public typings; it is read-only telemetry, used here only by the
      // headless LOD harness.
      const s = (tileset as unknown as { statistics: Record<string, number | undefined> }).statistics;
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
        rootBoundingRadius: Math.round(cloud.boundingSphere.radius),
        // Lets the harness weigh the chunk-size trade-off: fewer external
        // tilesets means fewer round trips but a larger root document.
        tilesetUrl: tileset.resource.url,
        pointsSelected: s.numberOfPointsSelected ?? null,
        tilesSelected: s.selected ?? null,
        tilesVisited: s.visited ?? null,
        tilesLoaded: s.numberOfLoadedTilesTotal ?? null,
        tilesTotal: s.numberOfTilesTotal ?? null,
        tilesWithContentReady: s.numberOfTilesWithContentReady ?? null,
        geometryBytes: s.geometryByteLength ?? null,
        colorMode: cloud.colorMode,
        hasColor: cloud.hasColor,
        attributes: cloud.attributes.join(',') || null,
        maximumScreenSpaceError: tileset.maximumScreenSpaceError,
        geometricErrorScale: tileset.pointCloudShading.geometricErrorScale,
        maximumAttenuation: tileset.pointCloudShading.maximumAttenuation,
        dynamicScreenSpaceError: tileset.dynamicScreenSpaceError,
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
