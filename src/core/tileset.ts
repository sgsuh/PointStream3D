import { Bounds, Key } from 'copc';
import type { Copc, Hierarchy } from 'copc';
import type { ToEcefArr } from './georef';

export interface PageTilesetOptions {
  src: string;
  /** Root VoxelKey of this chunk ('0-0-0-0' for the top tileset, a sub-page root otherwise). */
  rootKey: string;
  /** Octree levels to emit inline before delegating deeper nodes to external tilesets. */
  chunkLevels: number;
  /** Page ref to reload for a chunk-boundary external tileset (the page these nodes came from). */
  fallbackPage: Hierarchy.Page;
}

/**
 * Build one 3D Tiles chunk from a single COPC hierarchy page.
 *
 * The COPC hierarchy is already paginated (an entry with pointCount === -1 is a
 * pointer to a sub-page). We map each page to a 3D Tiles **external tileset**:
 * when a child crosses a page boundary — or an artificial `chunkLevels`
 * boundary — we emit a tile whose content is another `page.json`, which the
 * Service Worker resolves lazily. This keeps every response small and loads the
 * octree on demand, scaling to arbitrarily large files.
 */
export function buildPageTileset(
  copc: Copc,
  nodes: Hierarchy.Node.Map,
  pages: Hierarchy.Page.Map,
  toEcef: ToEcefArr,
  opts: PageTilesetOptions,
): unknown {
  const rootSpacing = copc.info.spacing;
  const rootLevel = Number(opts.rootKey.split('-')[0]);
  const geometricError = (level: number) => rootSpacing / Math.pow(2, level);

  const query = (params: Record<string, string | number>) =>
    Object.entries(params)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? encodeURIComponent(v) : v}`)
      .join('&');

  const sphereOf = (key: string): number[] => {
    const b = Bounds.stepTo(copc.info.cube, Key.create(key)); // [minx,miny,minz,maxx,maxy,maxz]
    const corners: number[][] = [];
    for (const x of [b[0], b[3]]) {
      for (const y of [b[1], b[4]]) {
        for (const z of [b[2], b[5]]) corners.push(toEcef(x, y, z));
      }
    }
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const c of corners) {
      cx += c[0];
      cy += c[1];
      cz += c[2];
    }
    cx /= corners.length;
    cy /= corners.length;
    cz /= corners.length;
    let r = 0;
    for (const c of corners) r = Math.max(r, Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz));
    return [cx, cy, cz, r];
  };

  const externalTile = (childKey: string, page: Hierarchy.Page): Record<string, unknown> => ({
    boundingVolume: { sphere: sphereOf(childKey) },
    geometricError: geometricError(Number(childKey.split('-')[0])),
    refine: 'ADD',
    content: {
      uri: `page.json?${query({ src: opts.src, key: childKey, o: page.pageOffset, l: page.pageLength })}`,
    },
  });

  const build = (key: string): Record<string, unknown> => {
    const [l, x, y, z] = key.split('-').map(Number);
    const node = nodes[key];
    const tile: Record<string, unknown> = {
      boundingVolume: { sphere: sphereOf(key) },
      geometricError: geometricError(l),
      refine: 'ADD',
    };
    if (node && node.pointCount > 0) {
      tile.content = {
        uri: `${key}.pnts?${query({ src: opts.src, o: node.pointDataOffset, l: node.pointDataLength, c: node.pointCount })}`,
      };
    }

    const atChunkBoundary = l - rootLevel >= opts.chunkLevels;
    const children: Record<string, unknown>[] = [];
    for (const dx of [0, 1]) {
      for (const dy of [0, 1]) {
        for (const dz of [0, 1]) {
          const ck = `${l + 1}-${x * 2 + dx}-${y * 2 + dy}-${z * 2 + dz}`;
          const subPage = pages[ck];
          if (subPage) {
            children.push(externalTile(ck, subPage)); // real COPC sub-page
          } else if (nodes[ck]) {
            children.push(atChunkBoundary ? externalTile(ck, opts.fallbackPage) : build(ck));
          }
        }
      }
    }
    if (children.length) tile.children = children;
    return tile;
  };

  return {
    asset: { version: '1.0' },
    geometricError: geometricError(rootLevel),
    root: build(opts.rootKey),
  };
}
