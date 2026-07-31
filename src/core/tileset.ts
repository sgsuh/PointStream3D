import { Bounds, Key } from 'copc';
import type { Copc, Hierarchy } from 'copc';
import { metresPerSourceUnit, type ToEcefArr } from './georef';
import { clampToData, orientedBox } from './bounds';

export interface PageTilesetOptions {
  src: string;
  /** Root VoxelKey of this chunk ('0-0-0-0' for the top tileset, a sub-page root otherwise). */
  rootKey: string;
  /** Tiles emitted inline before deeper nodes are delegated to external tilesets. */
  maxTilesPerChunk: number;
  /** Page ref to reload for a chunk-boundary external tileset (the page these nodes came from). */
  fallbackPage: Hierarchy.Page;
  /** Comma-separated per-point attributes to encode, forwarded to tile requests. */
  attributes?: string;
  /** Published on `asset.extras` of this document; Cesium keeps it on `tileset.asset`. */
  extras?: unknown;
}

/**
 * Build one 3D Tiles chunk from a single COPC hierarchy page.
 *
 * The COPC hierarchy is already paginated (an entry with pointCount === -1 is a
 * pointer to a sub-page). We map each page to a 3D Tiles **external tileset**:
 * when a child crosses a page boundary — or the `maxTilesPerChunk` budget — we
 * emit a tile whose content is another `page.json`, which the Service Worker
 * resolves lazily. This keeps every response small and loads the octree on
 * demand, scaling to arbitrarily large files.
 *
 * Page sizes vary a lot between writers (autzen's whole hierarchy is 278 nodes;
 * sofi's root page alone is 2710), so the split is budgeted by tile count rather
 * than octree depth, and the walk is breadth-first so a chunk holds complete
 * shallow levels instead of one deep branch.
 */
export function buildPageTileset(
  copc: Copc,
  nodes: Hierarchy.Node.Map,
  pages: Hierarchy.Page.Map,
  toEcef: ToEcefArr,
  opts: PageTilesetOptions,
): unknown {
  const rootLevel = Number(opts.rootKey.split('-')[0]);

  // COPC spacing is "distance between points at the root, halved each level", in
  // source-CRS units; 3D Tiles geometricError is metres. Cesium feeds it to both
  // the SSE test and point attenuation, so getting the unit wrong both
  // over-refines and inflates point size (autzen is in feet: 3.28x on both).
  const rootSpacing = copc.info.spacing * metresPerSourceUnit(toEcef, copc.info.cube);
  const geometricError = (level: number) => rootSpacing / Math.pow(2, level);

  const query = (params: Record<string, string | number>) =>
    Object.entries(params)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? encodeURIComponent(v) : v}`)
      .join('&');

  const boxOf = (key: string): number[] => {
    const cube = Bounds.stepTo(copc.info.cube, Key.create(key)); // [minx,miny,minz,maxx,maxy,maxz]
    return orientedBox(clampToData(cube, copc.header.min, copc.header.max), toEcef);
  };

  // Present only when attributes were requested, so URLs stay unchanged (and
  // caches stay warm) for the common colour-only case.
  const attrParam: Record<string, string> = opts.attributes ? { a: opts.attributes } : {};

  const pageUri = (childKey: string, page: Hierarchy.Page) =>
    `page.json?${query({
      src: opts.src,
      key: childKey,
      o: page.pageOffset,
      l: page.pageLength,
      mt: opts.maxTilesPerChunk,
      ...attrParam,
    })}`;

  const externalTile = (childKey: string, page: Hierarchy.Page): Record<string, unknown> => ({
    boundingVolume: { box: boxOf(childKey) },
    geometricError: geometricError(Number(childKey.split('-')[0])),
    refine: 'ADD',
    content: { uri: pageUri(childKey, page) },
  });

  const makeTile = (key: string): Record<string, unknown> => {
    const node = nodes[key];
    const tile: Record<string, unknown> = {
      boundingVolume: { box: boxOf(key) },
      geometricError: geometricError(Number(key.split('-')[0])),
      refine: 'ADD',
    };
    if (node && node.pointCount > 0) {
      tile.content = {
        uri: `${key}.pnts?${query({
          src: opts.src,
          o: node.pointDataOffset,
          l: node.pointDataLength,
          c: node.pointCount,
          ...attrParam,
        })}`,
      };
    }
    return tile;
  };

  const hasChildren = (key: string): boolean => {
    const [l, x, y, z] = key.split('-').map(Number);
    for (const dx of [0, 1]) {
      for (const dy of [0, 1]) {
        for (const dz of [0, 1]) {
          const ck = `${l + 1}-${x * 2 + dx}-${y * 2 + dy}-${z * 2 + dz}`;
          if (nodes[ck] || pages[ck]) return true;
        }
      }
    }
    return false;
  };

  const root = makeTile(opts.rootKey);
  const queue: [string, Record<string, unknown>][] = [[opts.rootKey, root]];
  // Counts every tile the document will contain, delegated ones included: a
  // frontier of external references costs just as many bytes as inline tiles.
  let emitted = 1;
  let head = 0;
  for (; head < queue.length; head++) {
    // The chunk root always expands, otherwise it would delegate to itself.
    if (head > 0 && emitted >= opts.maxTilesPerChunk) break;
    const [key, tile] = queue[head];
    const [l, x, y, z] = key.split('-').map(Number);
    const children: Record<string, unknown>[] = [];
    for (const dx of [0, 1]) {
      for (const dy of [0, 1]) {
        for (const dz of [0, 1]) {
          const ck = `${l + 1}-${x * 2 + dx}-${y * 2 + dy}-${z * 2 + dz}`;
          const subPage = pages[ck];
          if (subPage) {
            children.push(externalTile(ck, subPage)); // real COPC sub-page
            emitted++;
          } else if (nodes[ck]) {
            const child = makeTile(ck);
            children.push(child);
            queue.push([ck, child]);
            emitted++;
          }
        }
      }
    }
    if (children.length) tile.children = children;
  }

  // Whatever is still queued was emitted as an inline tile but never expanded.
  // Turn each into an external tileset so its subtree loads on demand; the
  // chunk we delegate to re-emits the node's own points as its root. A frontier
  // node that has no children is left alone — delegating a leaf would spend a
  // round trip to fetch a chunk holding the tile we already have.
  for (let i = head; i < queue.length; i++) {
    const [key, tile] = queue[i];
    if (hasChildren(key)) tile.content = { uri: pageUri(key, opts.fallbackPage) };
  }

  return {
    asset: opts.extras ? { version: '1.0', extras: opts.extras } : { version: '1.0' },
    geometricError: geometricError(rootLevel),
    root,
  };
}
