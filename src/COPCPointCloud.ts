import { Cesium3DTileset, type BoundingSphere } from 'cesium';
import type { COPCAttribute } from './core/CopcSource';
import { buildColorStyle, COLOR_MODE_ATTRIBUTE, type COPCColorMode } from './styles';

/** Metadata the Service Worker publishes on the generated tileset's asset. */
interface COPCTilesetExtras {
  pointCount: number;
  hasColor: boolean;
  heightRange: [number, number];
  intensityRange: [number, number] | null;
}

/**
 * Where to find the Service Worker that transcodes COPC into 3D Tiles.
 *
 * A Service Worker only sees fetches from clients inside its scope, so the
 * script has to be served from the app's base path (or from a narrower path
 * widened with a `Service-Worker-Allowed` response header). `laz-perf.wasm`
 * must sit next to it.
 */
export interface COPCServiceWorkerOptions {
  /** Script URL. Defaults to `pointstream3d-sw.js` next to the document base. */
  url?: string | URL;
  /** Registration scope. Defaults to the directory the script is served from. */
  scope?: string;
  /**
   * Set false when the app registers the worker itself; the existing
   * registration for this page is used instead.
   */
  register?: boolean;
}

/** Point-cloud shading, forwarded to `Cesium3DTileset.pointCloudShading`. */
export interface COPCPointCloudShadingOptions {
  attenuation?: boolean;
  eyeDomeLighting?: boolean;
  eyeDomeLightingStrength?: number;
  eyeDomeLightingRadius?: number;
  geometricErrorScale?: number;
  maximumAttenuation?: number;
}

export interface COPCPointCloudOptions {
  serviceWorker?: COPCServiceWorkerOptions;
  /**
   * How to colour points. `rgb` uses the file's own colour; the others are
   * driven by a per-point attribute, which is requested automatically.
   * Defaults to `rgb` when the file has colour, `elevation` when it does not.
   */
  colorMode?: COPCColorMode;
  /**
   * Per-point attributes to encode into tiles, beyond what `colorMode` needs.
   * Each costs bytes per point (height 4, intensity 2, classification 1, against
   * 15 for position and colour), so request only what you use — but requesting
   * a mode's attribute up front makes switching to it instant, with no refetch.
   */
  attributes?: COPCAttribute[];
  /** Pixels of allowed error before a tile refines. */
  maximumScreenSpaceError?: number;
  /** Tiles per generated tileset document before deeper nodes are delegated. */
  maxTilesPerChunk?: number;
  pointCloudShading?: COPCPointCloudShadingOptions;
  /** Point budget: bytes of tile content kept before Cesium evicts. */
  cacheBytes?: number;
  maximumCacheOverflowBytes?: number;
  /** Relax screen-space error with distance. Only pays off on very large data. */
  dynamicScreenSpaceError?: boolean;
}

/**
 * Defaults measured on autzen and sofi — see `docs/architecture.md` §8.1.
 *
 * These assume `geometricError` is the true point spacing in metres, which is
 * what the worker emits; Cesium's own default of 16 is far too coarse against
 * an accurate value.
 */
export const COPC_DEFAULTS = {
  maximumScreenSpaceError: 4,
  maxTilesPerChunk: 512,
  cacheBytes: 512 * 1024 * 1024,
  maximumCacheOverflowBytes: 512 * 1024 * 1024,
  dynamicScreenSpaceError: false,
  pointCloudShading: {
    attenuation: true,
    eyeDomeLighting: true,
    eyeDomeLightingStrength: 1.0,
    eyeDomeLightingRadius: 1.0,
    // Square splats over an irregular distribution leave holes at exactly one
    // spacing; 1.5 closes them without blurring detail away.
    geometricErrorScale: 1.5,
    maximumAttenuation: 8,
  },
} as const;

const DEFAULT_SW_FILE = 'pointstream3d-sw.js';

async function ensureServiceWorker(options: COPCServiceWorkerOptions = {}): Promise<string> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error(
      'PointStream3D requires Service Workers, which need a secure context ' +
        '(https, or localhost during development).',
    );
  }

  const registration =
    options.register === false
      ? await navigator.serviceWorker.ready
      : await navigator.serviceWorker.register(options.url ?? new URL(DEFAULT_SW_FILE, document.baseURI), {
          type: 'module',
          scope: options.scope,
        });

  await navigator.serviceWorker.ready;
  // The worker calls skipWaiting + clients.claim, so it takes control straight
  // away — but on a first load the controller can land a beat later.
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    });
  }
  return registration.scope;
}

/**
 * A COPC file streamed into CesiumJS as 3D Tiles, with no pre-tiling step.
 *
 * A Service Worker transcodes the octree into tileset documents and `pnts` tiles
 * as Cesium asks for them, so Cesium drives level of detail, culling, request
 * scheduling and memory, and applies eye-dome lighting and point attenuation to
 * the result.
 *
 * ```ts
 * const cloud = await COPCPointCloud.fromUrl('/data/autzen.copc.laz');
 * viewer.scene.primitives.add(cloud.tileset);
 * await viewer.zoomTo(cloud.tileset);
 * ```
 */
export class COPCPointCloud {
  private destroyed = false;
  private mode: COPCColorMode;

  private constructor(
    /** Absolute URL of the COPC file being streamed. */
    readonly url: string,
    /**
     * The underlying tileset. Add it to `viewer.scene.primitives`; every
     * Cesium 3D Tiles feature — styling, picking, events — applies to it.
     */
    readonly tileset: Cesium3DTileset,
    /** Per-point attributes the tiles actually carry. */
    readonly attributes: readonly COPCAttribute[],
    private readonly extras: COPCTilesetExtras | undefined,
    colorMode: COPCColorMode,
  ) {
    this.mode = colorMode;
    this.applyStyle();
  }

  static async fromUrl(url: string | URL, options: COPCPointCloudOptions = {}): Promise<COPCPointCloud> {
    const scope = await ensureServiceWorker(options.serviceWorker);
    // Resolve against the page so a relative path does not depend on where the
    // worker happens to be scoped.
    const src = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).href;
    const endpoint = (name: string) => {
      const u = new URL(`copc-tiles/${name}`, scope);
      u.searchParams.set('src', src);
      return u;
    };

    // Choosing a default colour mode needs to know whether the file has colour,
    // and that has to happen before the tileset URL is formed — the URL encodes
    // which attributes tiles carry. One header-only request settles it.
    let colorMode = options.colorMode;
    if (!colorMode) {
      const info = (await fetch(endpoint('info.json')).then((r) => r.json())) as COPCTilesetExtras;
      colorMode = info.hasColor ? 'rgb' : 'elevation';
    }

    const needed = COLOR_MODE_ATTRIBUTE[colorMode];
    const attributes = [...new Set([...(options.attributes ?? []), ...(needed ? [needed] : [])])];

    const tilesetUrl = endpoint('tileset.json');
    tilesetUrl.searchParams.set(
      'mt',
      String(options.maxTilesPerChunk ?? COPC_DEFAULTS.maxTilesPerChunk),
    );
    if (attributes.length) tilesetUrl.searchParams.set('a', attributes.join(','));

    const tileset = await Cesium3DTileset.fromUrl(tilesetUrl.href, {
      maximumScreenSpaceError:
        options.maximumScreenSpaceError ?? COPC_DEFAULTS.maximumScreenSpaceError,
    });
    const extras = (tileset.asset as { extras?: { pointstream3d?: COPCTilesetExtras } } | undefined)
      ?.extras?.pointstream3d;

    const shading = { ...COPC_DEFAULTS.pointCloudShading, ...options.pointCloudShading };
    Object.assign(tileset.pointCloudShading, shading);
    tileset.cacheBytes = options.cacheBytes ?? COPC_DEFAULTS.cacheBytes;
    tileset.maximumCacheOverflowBytes =
      options.maximumCacheOverflowBytes ?? COPC_DEFAULTS.maximumCacheOverflowBytes;
    tileset.dynamicScreenSpaceError =
      options.dynamicScreenSpaceError ?? COPC_DEFAULTS.dynamicScreenSpaceError;

    return new COPCPointCloud(src, tileset, attributes, extras, colorMode);
  }

  /** Bounding volume of the whole file, for `viewer.zoomTo`/`flyTo`. */
  get boundingSphere(): BoundingSphere {
    return this.tileset.boundingSphere;
  }

  /** Total points in the file, as reported by its header. */
  get pointCount(): number | undefined {
    return this.extras?.pointCount;
  }

  /** Whether the file carries per-point RGB. */
  get hasColor(): boolean | undefined {
    return this.extras?.hasColor;
  }

  /**
   * Active colour mode. Assigning swaps the GPU style — no tiles are refetched.
   *
   * Switching to a mode whose attribute was not requested at load time throws,
   * because the tiles simply do not carry it; pass it in `attributes` up front.
   */
  get colorMode(): COPCColorMode {
    return this.mode;
  }

  set colorMode(mode: COPCColorMode) {
    const needed = COLOR_MODE_ATTRIBUTE[mode];
    if (needed && !this.attributes.includes(needed)) {
      throw new Error(
        `colorMode "${mode}" needs the "${needed}" attribute, which these tiles do not carry. ` +
          `Pass attributes: ['${needed}'] to COPCPointCloud.fromUrl().`,
      );
    }
    this.mode = mode;
    this.applyStyle();
  }

  private applyStyle(): void {
    this.tileset.style = buildColorStyle(this.mode, {
      heightRange: this.extras?.heightRange,
      intensityRange: this.extras?.intensityRange,
    });
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Destroy the tileset and drop the worker's cached header and hierarchy pages
   * for this file. Nothing else evicts those — they are keyed by source URL and
   * outlive the tileset.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    navigator.serviceWorker?.controller?.postMessage({
      type: 'pointstream3d:release',
      src: this.url,
    });
    if (!this.tileset.isDestroyed()) this.tileset.destroy();
  }
}
