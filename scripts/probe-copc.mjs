// Probe a COPC file (local path or remote URL) WITHOUT downloading it fully:
// read the header + root hierarchy page via range requests and report whether
// the hierarchy is split into sub-pages (i.e. a real multi-page file), plus the
// octree cube vs. actual data extent — the ratio drives how much bounding-volume
// tightening is worth on this file (see docs/architecture.md, LOD tuning).
//   docker compose run --rm web node scripts/probe-copc.mjs <url-or-path>
import { Copc } from 'copc';

const round = (a) => a.map((v) => Number(v.toFixed(2)));

const src = process.argv[2];
if (!src) {
  console.error('usage: probe-copc.mjs <url-or-path>');
  process.exit(1);
}

try {
  const copc = await Copc.create(src);
  const { nodes, pages } = await Copc.loadHierarchyPage(src, copc.info.rootHierarchyPage);
  const nSubPages = Object.keys(pages).length;
  const { min, max } = copc.header;
  const cube = copc.info.cube;
  const dataSize = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cubeSide = cube[3] - cube[0];
  // Bounding-sphere radius of the whole cube vs. of the actual data extent: how
  // much a naive cube-derived bounding volume over-covers empty space.
  const radius = (s) => Math.hypot(s[0], s[1], s[2]) / 2;
  console.log(JSON.stringify({
    src,
    totalPoints: copc.header.pointCount,
    rootPageNodes: Object.keys(nodes).length,
    subPages: nSubPages,
    multiPage: nSubPages > 0,
    subPageKeys: Object.keys(pages).slice(0, 8),
    spacing: copc.info.spacing,
    dataMin: round(min),
    dataMax: round(max),
    dataSize: round(dataSize),
    cubeSide: Number(cubeSide.toFixed(2)),
    cubeVsDataRadius: Number((radius([cubeSide, cubeSide, cubeSide]) / radius(dataSize)).toFixed(2)),
    cubeVsDataVolume: Number((cubeSide ** 3 / (dataSize[0] * dataSize[1] * dataSize[2])).toFixed(2)),
  }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ src, error: e.message }));
}
