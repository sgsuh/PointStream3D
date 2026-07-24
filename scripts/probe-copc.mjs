// Probe a COPC file (local path or remote URL) WITHOUT downloading it fully:
// read the header + root hierarchy page via range requests and report whether
// the hierarchy is split into sub-pages (i.e. a real multi-page file).
//   docker compose run --rm web node scripts/probe-copc.mjs <url-or-path>
import { Copc } from 'copc';

const src = process.argv[2];
if (!src) {
  console.error('usage: probe-copc.mjs <url-or-path>');
  process.exit(1);
}

try {
  const copc = await Copc.create(src);
  const { nodes, pages } = await Copc.loadHierarchyPage(src, copc.info.rootHierarchyPage);
  const nSubPages = Object.keys(pages).length;
  console.log(JSON.stringify({
    src,
    totalPoints: copc.header.pointCount,
    rootPageNodes: Object.keys(nodes).length,
    subPages: nSubPages,
    multiPage: nSubPages > 0,
    subPageKeys: Object.keys(pages).slice(0, 8),
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ src, error: e.message }));
}
