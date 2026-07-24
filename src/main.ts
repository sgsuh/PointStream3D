import {
  Viewer,
  PointPrimitiveCollection,
  Color,
  Cartesian3,
  BoundingSphere,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { CopcSource } from './core/CopcSource';
import { makeToEcef } from './core/reproject';

// PoC config -----------------------------------------------------------------
// Sample to load. autzen = real geolocated (Oregon); ellipsoid = tiny synthetic.
const DATA_URL = '/data/autzen.copc.laz';
// Octree depth to load for this PoC (0 = coarsest root node).
const MAX_DEPTH = 3;
// Cap total points — PointPrimitiveCollection is a PoC stand-in, not the final
// renderer (that's the 3D Tiles path), so keep the interactive load small.
const POINT_BUDGET = 300_000;
// ----------------------------------------------------------------------------

const statusEl = document.getElementById('status')!;
const setStatus = (m: string) => {
  statusEl.textContent = m;
  console.log('[PointStream3D]', m);
};

async function main() {
  const viewer = new Viewer('cesiumContainer', {
    // No imagery layer -> no Cesium ion token required for this PoC.
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

  setStatus('Loading COPC header…');
  const src = await CopcSource.fromUrl(DATA_URL, lazPerfWasmUrl);
  const total = src.copc.header.pointCount;
  console.log('[PointStream3D] COPC', {
    header: src.copc.header,
    info: src.copc.info,
    wkt: src.copc.wkt,
  });
  setStatus(`Header OK — ${total.toLocaleString()} points total. Loading octree hierarchy…`);

  const { nodes } = await src.loadHierarchy();
  const toEcef = makeToEcef(src.copc.wkt);
  const collection = viewer.scene.primitives.add(new PointPrimitiveCollection());
  const sampleForSphere: Cartesian3[] = [];

  // Select nodes up to MAX_DEPTH, coarse-to-fine.
  const selected = Object.keys(nodes)
    .filter((k) => nodes[k] && Number(k.split('-')[0]) <= MAX_DEPTH)
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));

  let rendered = 0;
  let usedNodes = 0;
  for (const key of selected) {
    if (rendered >= POINT_BUDGET) break;
    const node = nodes[key];
    if (!node || node.pointCount <= 0) continue;

    const dec = await src.decodeNode(key, node);
    const take = Math.min(dec.pointCount, POINT_BUDGET - rendered);
    for (let i = 0; i < take; i++) {
      const pos = toEcef(
        dec.positions[i * 3],
        dec.positions[i * 3 + 1],
        dec.positions[i * 3 + 2],
      );
      const color = dec.colors
        ? Color.fromBytes(dec.colors[i * 3], dec.colors[i * 3 + 1], dec.colors[i * 3 + 2])
        : Color.YELLOW;
      collection.add({ position: pos, color, pixelSize: 2 });
      if ((i & 63) === 0) sampleForSphere.push(pos); // subsample for framing
    }
    rendered += take;
    usedNodes += 1;
    setStatus(`Rendering… ${rendered.toLocaleString()} points (node ${key})`);
    await new Promise((r) => setTimeout(r)); // yield so the UI can paint
  }

  if (sampleForSphere.length) {
    const sphere = BoundingSphere.fromPoints(sampleForSphere);
    await viewer.camera.flyToBoundingSphere(sphere, { duration: 2 });
  }
  setStatus(
    `Done — ${rendered.toLocaleString()} points from ${usedNodes} octree nodes (depth ≤ ${MAX_DEPTH}).`,
  );
}

main().catch((e) => {
  console.error(e);
  setStatus('ERROR: ' + (e?.message ?? String(e)));
});
