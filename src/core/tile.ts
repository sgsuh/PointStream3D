// Turning one COPC octree node into one `pnts` tile: fetch, LAZ-decode,
// reproject, encode.
//
// This runs in two places — inside a decode worker (the normal path) and inside
// the Service Worker itself (the fallback when no worker is available) — so it
// lives here rather than in either of them.

import type { Hierarchy } from 'copc';
import { CopcSource, type COPCAttribute } from './CopcSource';
import { makeToEcefArr, type ToEcefArr } from './georef';
import { encodePnts, type BatchArray } from './pnts';
import { verticalMetreFactor } from './wkt';

export interface Meta {
  source: CopcSource;
  toEcef: ToEcefArr;
  /** Source vertical unit -> metre, so `Height` means the same across files. */
  heightScale: number;
}

/**
 * Immutable per-file metadata (header + CRS), cached by source URL. Everything
 * else is addressed statelessly, so there is no cross-request state to get
 * wrong. Each context keeps its own cache; the header is a couple of small range
 * reads, and reading it per worker beats serialising it between them.
 */
export class MetaCache {
  private readonly entries = new Map<string, Promise<Meta>>();

  constructor(private readonly wasmUrl: string) {}

  get(src: string): Promise<Meta> {
    let meta = this.entries.get(src);
    if (!meta) {
      meta = (async () => {
        const source = await CopcSource.fromUrl(src, this.wasmUrl);
        const wkt = source.copc.wkt;
        return {
          source,
          toEcef: makeToEcefArr(wkt),
          // With no CRS the data is already lon/lat/height in metres.
          heightScale: wkt ? verticalMetreFactor(wkt) : 1,
        };
      })();
      this.entries.set(src, meta);
    }
    return meta;
  }

  release(src: string): void {
    this.entries.delete(src);
  }
}

/** Decode one node and encode it as a `pnts` tile. */
export async function encodeNodeTile(
  meta: Meta,
  key: string,
  node: Hierarchy.Node,
  attributes: readonly COPCAttribute[],
): Promise<ArrayBuffer> {
  const { source, toEcef, heightScale } = meta;
  const dec = await source.decodeNode(key, node, attributes);
  const n = dec.pointCount;

  // Reproject to ECEF and pick RTC_CENTER = centroid (float32-friendly frame).
  const ecef = new Float64Array(n * 3);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = toEcef(dec.positions[i * 3], dec.positions[i * 3 + 1], dec.positions[i * 3 + 2]);
    ecef[i * 3] = x;
    ecef[i * 3 + 1] = y;
    ecef[i * 3 + 2] = z;
    cx += x;
    cy += y;
    cz += z;
  }
  const rtc: [number, number, number] = n ? [cx / n, cy / n, cz / n] : [0, 0, 0];

  // Per-point properties for styling. `Height` is carried explicitly rather than
  // read off the position: the styling language's ${POSITION} is in the tile's
  // own frame, and every tile has its own RTC_CENTER, so an elevation ramp built
  // on it would restart at each tile.
  const batch: Record<string, BatchArray> = {};
  if (dec.intensity) batch.Intensity = dec.intensity;
  if (dec.classification) batch.Classification = dec.classification;
  if (attributes.includes('height')) {
    const height = new Float32Array(n);
    for (let i = 0; i < n; i++) height[i] = dec.positions[i * 3 + 2] * heightScale;
    batch.Height = height;
  }

  return encodePnts(ecef, dec.colors, rtc, batch);
}
