import { Cesium3DTileset, type BoundingSphere } from 'cesium';

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

  private constructor(
    /** Absolute URL of the COPC file being streamed. */
    readonly url: string,
    /**
     * The underlying tileset. Add it to `viewer.scene.primitives`; every
     * Cesium 3D Tiles feature — styling, picking, events — applies to it.
     */
    readonly tileset: Cesium3DTileset,
  ) {}

  static async fromUrl(url: string | URL, options: COPCPointCloudOptions = {}): Promise<COPCPointCloud> {
    const scope = await ensureServiceWorker(options.serviceWorker);
    // Resolve against the page so a relative path does not depend on where the
    // worker happens to be scoped.
    const src = new URL(url, typeof document !== 'undefined' ? document.baseURI : undefined).href;

    const tilesetUrl = new URL('copc-tiles/tileset.json', scope);
    tilesetUrl.searchParams.set('src', src);
    tilesetUrl.searchParams.set(
      'mt',
      String(options.maxTilesPerChunk ?? COPC_DEFAULTS.maxTilesPerChunk),
    );

    const tileset = await Cesium3DTileset.fromUrl(tilesetUrl.href, {
      maximumScreenSpaceError:
        options.maximumScreenSpaceError ?? COPC_DEFAULTS.maximumScreenSpaceError,
    });

    const shading = { ...COPC_DEFAULTS.pointCloudShading, ...options.pointCloudShading };
    Object.assign(tileset.pointCloudShading, shading);
    tileset.cacheBytes = options.cacheBytes ?? COPC_DEFAULTS.cacheBytes;
    tileset.maximumCacheOverflowBytes =
      options.maximumCacheOverflowBytes ?? COPC_DEFAULTS.maximumCacheOverflowBytes;
    tileset.dynamicScreenSpaceError =
      options.dynamicScreenSpaceError ?? COPC_DEFAULTS.dynamicScreenSpaceError;

    return new COPCPointCloud(src, tileset);
  }

  /** Bounding volume of the whole file, for `viewer.zoomTo`/`flyTo`. */
  get boundingSphere(): BoundingSphere {
    return this.tileset.boundingSphere;
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
