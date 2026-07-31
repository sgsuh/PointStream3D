/// <reference lib="webworker" />
import type { Hierarchy } from 'copc';
import { CopcSource, type COPCAttribute } from '../core/CopcSource';
import { makeToEcefArr, type ToEcefArr } from '../core/georef';
import { buildPageTileset } from '../core/tileset';
import { encodePnts, type BatchArray } from '../core/pnts';
import { verticalMetreFactor } from '../core/wkt';

// Service Worker that transcodes a COPC file into 3D Tiles on the fly, one
// hierarchy page at a time (external tilesets) so it scales to huge files:
//   GET <scope>copc-tiles/tileset.json?src=<url>            -> root chunk
//   GET <scope>copc-tiles/page.json?src=<url>&key=&o=&l=    -> a sub-page chunk (external tileset)
//   GET <scope>copc-tiles/<l-x-y-z>.pnts?src=<url>&o=&l=&c= -> one node as `pnts`
// Cesium's Cesium3DTileset drives LOD/culling/memory and applies point-cloud
// shading (EDL) to our tiles for free.

declare const self: ServiceWorkerGlobalScope;

// Everything is addressed relative to the registration scope rather than the
// site root, so the library also works when the app is served under a base path
// (a GitHub Pages project site, say). A Service Worker only receives fetch
// events from clients inside its scope, so that scope has to cover the page —
// serve this file from the app's base path, or widen it with the
// `Service-Worker-Allowed` header.
const PREFIX = new URL('copc-tiles/', self.registration.scope).pathname;
// The wasm is expected next to this script.
const WASM_URL = new URL('laz-perf.wasm', self.location.href).href;
// Tiles emitted per external tileset, overridable with `?mt=`.
//
// Every artificial split costs a round trip before Cesium may refine deeper, so
// we want chunks as large as stays cheap to generate and parse: 512 tiles keeps
// autzen's 278-node hierarchy in a single ~100 kB document, while sofi's
// 2710-node root page is cut from 1.08 MB into lazily-loaded pieces.
const DEFAULT_MAX_TILES_PER_CHUNK = 512;

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

interface Meta {
  source: CopcSource;
  toEcef: ToEcefArr;
  /** Source vertical unit -> metre, so `Height` means the same across files. */
  heightScale: number;
}

// Immutable per-file metadata (header + CRS). Everything else is addressed
// statelessly through URL params, so no cross-request state to get wrong.
const metaCache = new Map<string, Promise<Meta>>();
function getMeta(src: string): Promise<Meta> {
  let m = metaCache.get(src);
  if (!m) {
    m = (async () => {
      const source = await CopcSource.fromUrl(src, WASM_URL);
      const wkt = source.copc.wkt;
      return {
        source,
        toEcef: makeToEcefArr(wkt),
        // With no CRS the data is already lon/lat/height in metres.
        heightScale: wkt ? verticalMetreFactor(wkt) : 1,
      };
    })();
    metaCache.set(src, m);
  }
  return m;
}

const ATTRIBUTES: readonly COPCAttribute[] = ['intensity', 'classification', 'height'];

function attributesFrom(url: URL): COPCAttribute[] {
  const raw = url.searchParams.get('a');
  if (!raw) return [];
  return raw.split(',').filter((a): a is COPCAttribute => (ATTRIBUTES as readonly string[]).includes(a));
}

// LAS has no header field for the intensity range, and a ramp needs one, so it
// is measured from the root node — the one node every viewer loads anyway.
const intensityRangeCache = new Map<string, Promise<[number, number] | null>>();
function getIntensityRange(src: string): Promise<[number, number] | null> {
  let r = intensityRangeCache.get(src);
  if (!r) {
    r = (async () => {
      const { source } = await getMeta(src);
      const { nodes } = await getPage(source, src, source.copc.info.rootHierarchyPage);
      const root = nodes['0-0-0-0'];
      if (!root || root.pointCount <= 0) return null;
      const { intensity } = await source.decodeNode('0-0-0-0', root, ['intensity']);
      if (!intensity?.length) return null;
      let min = Infinity;
      let max = -Infinity;
      for (const v of intensity) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return [min, max] as [number, number];
    })().catch(() => null);
    intensityRangeCache.set(src, r);
  }
  return r;
}

// Parsed hierarchy pages, keyed by (src, offset, length).
const pageCache = new Map<string, Promise<Hierarchy.Subtree>>();
function getPage(source: CopcSource, src: string, page: Hierarchy.Page): Promise<Hierarchy.Subtree> {
  const k = `${src}|${page.pageOffset}|${page.pageLength}`;
  let p = pageCache.get(k);
  if (!p) {
    p = source.loadHierarchy(page);
    pageCache.set(k, p);
  }
  return p;
}

// A page releases a file's metadata and parsed hierarchy pages when its point
// cloud is destroyed. Nothing else evicts them: they are keyed by source URL and
// live as long as the worker does.
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; src?: string } | undefined;
  if (data?.type !== 'pointstream3d:release' || !data.src) return;
  metaCache.delete(data.src);
  for (const key of [...pageCache.keys()]) {
    if (key.startsWith(`${data.src}|`)) pageCache.delete(key);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  const src = url.searchParams.get('src');
  if (!src) return;

  if (url.pathname === `${PREFIX}info.json`) {
    // Header-only metadata, so the client can pick a default colour mode before
    // it commits to a tileset URL (which encodes the attribute set).
    event.respondWith(
      getMeta(src)
        .then(() => rootExtras(src, attributesFrom(url)))
        .then((extras) => json(extras.pointstream3d))
        .catch((e: Error) => new Response(`info error: ${e.message}`, { status: 500 })),
    );
  } else if (url.pathname === `${PREFIX}tileset.json`) {
    event.respondWith(serveChunk(src, '0-0-0-0', null, maxTilesFrom(url), attributesFrom(url)));
  } else if (url.pathname === `${PREFIX}page.json`) {
    const key = url.searchParams.get('key')!;
    const page = pageFromParams(url);
    event.respondWith(serveChunk(src, key, page, maxTilesFrom(url), attributesFrom(url)));
  } else if (url.pathname.endsWith('.pnts')) {
    event.respondWith(serveTile(src, url));
  }
});

function pageFromParams(url: URL): Hierarchy.Page {
  return {
    pageOffset: Number(url.searchParams.get('o')),
    pageLength: Number(url.searchParams.get('l')),
  };
}

function maxTilesFrom(url: URL): number {
  const mt = Number(url.searchParams.get('mt'));
  // Below one octree level's worth of children a chunk carries almost no
  // hierarchy, so the walk would cost a round trip per level.
  return Number.isFinite(mt) && mt >= 9 ? mt : DEFAULT_MAX_TILES_PER_CHUNK;
}

async function serveChunk(
  src: string,
  rootKey: string,
  page: Hierarchy.Page | null,
  maxTilesPerChunk: number,
  attributes: COPCAttribute[],
): Promise<Response> {
  try {
    const { source, toEcef } = await getMeta(src);
    const pageRef = page ?? source.copc.info.rootHierarchyPage;
    const { nodes, pages } = await getPage(source, src, pageRef);
    const tileset = buildPageTileset(source.copc, nodes, pages, toEcef, {
      src,
      rootKey,
      maxTilesPerChunk,
      fallbackPage: pageRef,
      attributes: attributes.join(',') || undefined,
      // Only the root document is read for metadata; the ranges a colour ramp
      // needs are known here and nowhere on the client.
      extras: page ? undefined : await rootExtras(src, attributes),
    });
    return json(tileset);
  } catch (e) {
    return new Response(`chunk error: ${(e as Error).message}`, { status: 500 });
  }
}

/** Metadata the client cannot derive, published on the root document's asset. */
async function rootExtras(src: string, attributes: COPCAttribute[]) {
  const { source, heightScale } = await getMeta(src);
  const { header } = source.copc;
  return {
    pointstream3d: {
      pointCount: header.pointCount,
      // LAS point formats carrying RGB. Note 6 does not — sofi is format 6.
      hasColor: [2, 3, 5, 7, 8, 10].includes(header.pointDataRecordFormat),
      heightRange: [header.min[2] * heightScale, header.max[2] * heightScale],
      intensityRange: attributes.includes('intensity') ? await getIntensityRange(src) : null,
    },
  };
}

async function serveTile(src: string, url: URL): Promise<Response> {
  try {
    const { source, toEcef, heightScale } = await getMeta(src);
    const attributes = attributesFrom(url);
    const key = url.pathname.slice(PREFIX.length, -'.pnts'.length);
    const node: Hierarchy.Node = {
      pointCount: Number(url.searchParams.get('c')),
      pointDataOffset: Number(url.searchParams.get('o')),
      pointDataLength: Number(url.searchParams.get('l')),
    };
    if (!node.pointCount) return new Response('empty node', { status: 404 });

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

    // Per-point properties for styling. `Height` is carried explicitly rather
    // than read off the position: the styling language's ${POSITION} is in the
    // tile's own frame, and every tile has its own RTC_CENTER, so an elevation
    // ramp built on it would restart at each tile.
    const batch: Record<string, BatchArray> = {};
    if (dec.intensity) batch.Intensity = dec.intensity;
    if (dec.classification) batch.Classification = dec.classification;
    if (attributes.includes('height')) {
      const height = new Float32Array(n);
      for (let i = 0; i < n; i++) height[i] = dec.positions[i * 3 + 2] * heightScale;
      batch.Height = height;
    }

    return new Response(encodePnts(ecef, dec.colors, rtc, batch), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  } catch (e) {
    return new Response(`tile error: ${(e as Error).message}`, { status: 500 });
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
