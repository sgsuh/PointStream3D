import { Copc, Bounds, Key, type Getter, type Hierarchy } from 'copc';
import { getLazPerf } from './lazperf';

/**
 * A browser Getter backed by HTTP range requests. Passing our own Getter lets
 * copc.js skip its Node `fs`/`cross-fetch` code paths entirely.
 * Note: copc's Getter contract uses an EXCLUSIVE `end`, HTTP Range is inclusive.
 */
export function httpRangeGetter(url: string): Getter {
  return async (begin: number, end: number): Promise<Uint8Array> => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Range fetch failed (${res.status}) for ${url}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };
}

/**
 * Optional per-point LAS dimensions to decode alongside position and colour.
 * `height` is not a LAS dimension — it is Z converted to metres, and is added by
 * the caller that knows the CRS.
 */
export type COPCAttribute = 'intensity' | 'classification' | 'height';

export interface DecodedNode {
  key: string;
  pointCount: number;
  /** XYZ triples in the source CRS (scale/offset already applied). */
  positions: Float64Array;
  /** RGB triples 0-255, if the file carries color. */
  colors?: Uint8Array;
  /** Raw LAS intensity, if requested and present. */
  intensity?: Uint16Array;
  /** ASPRS classification code, if requested and present. */
  classification?: Uint8Array;
  /** [minx, miny, minz, maxx, maxy, maxz] in the source CRS. */
  bounds: number[];
}

/** Thin wrapper over copc.js: metadata, hierarchy, and per-node decoding. */
export class CopcSource {
  private constructor(
    readonly url: string,
    readonly getter: Getter,
    readonly copc: Copc,
    readonly lazPerfWasmUrl: string,
  ) {}

  static async fromUrl(url: string, lazPerfWasmUrl: string): Promise<CopcSource> {
    const getter = httpRangeGetter(url);
    const copc = await Copc.create(getter);
    return new CopcSource(url, getter, copc, lazPerfWasmUrl);
  }

  /** Load a hierarchy page (defaults to the root octree page). */
  loadHierarchy(page: Hierarchy.Page = this.copc.info.rootHierarchyPage) {
    return Copc.loadHierarchyPage(this.getter, page);
  }

  /** Axis-aligned bounds of an octree node, derived from its VoxelKey. */
  boundsOf(key: string): number[] {
    return Bounds.stepTo(this.copc.info.cube, Key.create(key));
  }

  /** Fetch + LAZ-decode one node into typed arrays. */
  async decodeNode(
    key: string,
    node: Hierarchy.Node,
    attributes: readonly COPCAttribute[] = [],
  ): Promise<DecodedNode> {
    const view = await Copc.loadPointDataView(this.getter, this.copc, node, {
      lazPerf: await getLazPerf(this.lazPerfWasmUrl),
    });
    const n = view.pointCount;

    const gx = view.getter('X');
    const gy = view.getter('Y');
    const gz = view.getter('Z');
    const positions = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = gx(i);
      positions[i * 3 + 1] = gy(i);
      positions[i * 3 + 2] = gz(i);
    }

    let colors: Uint8Array | undefined;
    if (view.dimensions.Red && view.dimensions.Green && view.dimensions.Blue) {
      const gr = view.getter('Red');
      const gg = view.getter('Green');
      const gb = view.getter('Blue');
      colors = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        let r = gr(i);
        let g = gg(i);
        let b = gb(i);
        // LAS RGB is 16-bit; collapse to 8-bit when needed.
        if (r > 255 || g > 255 || b > 255) {
          r >>= 8;
          g >>= 8;
          b >>= 8;
        }
        colors[i * 3] = r;
        colors[i * 3 + 1] = g;
        colors[i * 3 + 2] = b;
      }
    }

    // Optional per-point dimensions. Point formats differ in what they carry, so
    // each is emitted only when the file actually has it.
    let intensity: Uint16Array | undefined;
    if (attributes.includes('intensity') && view.dimensions.Intensity) {
      const g = view.getter('Intensity');
      intensity = new Uint16Array(n);
      for (let i = 0; i < n; i++) intensity[i] = g(i);
    }

    let classification: Uint8Array | undefined;
    if (attributes.includes('classification') && view.dimensions.Classification) {
      const g = view.getter('Classification');
      classification = new Uint8Array(n);
      for (let i = 0; i < n; i++) classification[i] = g(i);
    }

    return {
      key,
      pointCount: n,
      positions,
      colors,
      intensity,
      classification,
      bounds: this.boundsOf(key),
    };
  }
}
