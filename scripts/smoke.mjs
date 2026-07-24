// Headless data-pipeline check (no browser): validates that copc.js + laz-perf
// decode a COPC node and that proj4 reprojects the source CRS to WGS84.
//   docker compose run --rm web npm run smoke [path-to.copc.laz]
import { Copc, Key, Bounds } from 'copc';
import proj4 from 'proj4';

// Inlined copies of src/core/wkt.ts helpers (kept dependency-free for Node).
function extractHorizontalWkt(wkt) {
  if (!wkt.startsWith('COMPD_CS')) return wkt;
  const start = wkt.indexOf('PROJCS') >= 0 ? wkt.indexOf('PROJCS') : wkt.indexOf('GEOGCS');
  if (start < 0) return wkt;
  const open = wkt.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < wkt.length; i++) {
    if (wkt[i] === '[') depth++;
    else if (wkt[i] === ']' && --depth === 0) return wkt.slice(start, i + 1);
  }
  return wkt.slice(start);
}
function verticalMetreFactor(wkt) {
  if (/ftus|us survey foot|foot_us/i.test(wkt)) return 0.3048006096;
  if (/\bfoot\b|\bfeet\b|\bft\b/i.test(wkt)) return 0.3048;
  return 1;
}

const file = process.argv[2] || 'public/data/autzen.copc.laz';
console.log('file:', file);

const copc = await Copc.create(file);
console.log('total points :', copc.header.pointCount.toLocaleString());
console.log('PDRF         :', copc.header.pointDataRecordFormat);
console.log('scale/offset :', copc.header.scale, copc.header.offset);
console.log('cube         :', copc.info.cube);
console.log('spacing      :', copc.info.spacing);
console.log('wkt          :', copc.wkt ? copc.wkt.slice(0, 90).replace(/\s+/g, ' ') + '…' : '(none)');

const { nodes, pages } = await Copc.loadHierarchyPage(file, copc.info.rootHierarchyPage);
const keys = Object.keys(nodes);
console.log('hierarchy    :', keys.length, 'nodes,', Object.keys(pages).length, 'sub-pages');

const rootKey = '0-0-0-0';
const root = nodes[rootKey];
console.log('root node    :', root);

const view = await Copc.loadPointDataView(file, copc, root);
console.log('root decoded :', view.pointCount.toLocaleString(), 'points,',
  Object.keys(view.dimensions).length, 'dimensions');

const gx = view.getter('X');
const gy = view.getter('Y');
const gz = view.getter('Z');
console.log('sample XYZ (source CRS):');
for (let i = 0; i < Math.min(3, view.pointCount); i++) {
  console.log('   ', gx(i).toFixed(2), gy(i).toFixed(2), gz(i).toFixed(2));
}

if (copc.wkt) {
  try {
    const t = proj4(extractHorizontalWkt(copc.wkt), 'EPSG:4326');
    const zf = verticalMetreFactor(copc.wkt);
    const [lon, lat] = t.forward([gx(0), gy(0)]);
    console.log('reproject pt0 -> lon/lat:', lon.toFixed(6), lat.toFixed(6),
      'height(m):', (gz(0) * zf).toFixed(2), `(zFactor ${zf})`);
  } catch (e) {
    console.log('proj4 WKT reprojection FAILED:', e.message);
  }
}

console.log('root bounds  :', Bounds.stepTo(copc.info.cube, Key.create(rootKey)));
console.log('SMOKE OK');
