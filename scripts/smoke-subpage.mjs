// Validate the NATURAL COPC sub-page path against a real multi-page file:
// load the root page, follow a real sub-page pointer, load that sub-page, and
// decode its root node. These are exactly the operations the Service Worker's
// serveChunk/serveTile do for a natural sub-page.
//   docker compose run --rm web node scripts/smoke-subpage.mjs [url]
import { Copc } from 'copc';

const src = process.argv[2] || 'https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz';
console.log('file:', src);

const copc = await Copc.create(src);
console.log('total points:', copc.header.pointCount.toLocaleString());

const root = await Copc.loadHierarchyPage(src, copc.info.rootHierarchyPage);
const subKeys = Object.keys(root.pages);
console.log('root page: nodes', Object.keys(root.nodes).length, '| sub-pages', subKeys.length);
if (!subKeys.length) {
  console.log('NOT A MULTI-PAGE FILE — nothing to validate');
  process.exit(0);
}

const key = subKeys[0]; // a real sub-page root, e.g. '4-3-3-1'
const pageRef = root.pages[key];
console.log('following sub-page pointer:', key, pageRef);

const sub = await Copc.loadHierarchyPage(src, pageRef);
const subNodeKeys = Object.keys(sub.nodes);
console.log('sub-page loaded: nodes', subNodeKeys.length,
  '| further sub-pages', Object.keys(sub.pages).length,
  '| contains its root node?', key in sub.nodes);

const node = sub.nodes[key];
console.log('sub-page root node:', node);

const view = await Copc.loadPointDataView(src, copc, node);
const gx = view.getter('X');
const gy = view.getter('Y');
const gz = view.getter('Z');
console.log('decoded', view.pointCount.toLocaleString(), 'points from the sub-page node');
console.log('sample XYZ:', gx(0).toFixed(2), gy(0).toFixed(2), gz(0).toFixed(2));
console.log('NATURAL SUB-PAGE PATH OK');
