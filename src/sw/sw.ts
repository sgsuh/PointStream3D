/// <reference lib="webworker" />
import type { Hierarchy } from 'copc';
import { CopcSource } from '../core/CopcSource';
import { makeToEcefArr, type ToEcefArr } from '../core/georef';
import { buildPageTileset } from '../core/tileset';
import { encodePnts } from '../core/pnts';

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
}

// Immutable per-file metadata (header + CRS). Everything else is addressed
// statelessly through URL params, so no cross-request state to get wrong.
const metaCache = new Map<string, Promise<Meta>>();
function getMeta(src: string): Promise<Meta> {
  let m = metaCache.get(src);
  if (!m) {
    m = (async () => {
      const source = await CopcSource.fromUrl(src, WASM_URL);
      return { source, toEcef: makeToEcefArr(source.copc.wkt) };
    })();
    metaCache.set(src, m);
  }
  return m;
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

  if (url.pathname === `${PREFIX}tileset.json`) {
    event.respondWith(serveChunk(src, '0-0-0-0', null, maxTilesFrom(url)));
  } else if (url.pathname === `${PREFIX}page.json`) {
    const key = url.searchParams.get('key')!;
    const page = pageFromParams(url);
    event.respondWith(serveChunk(src, key, page, maxTilesFrom(url)));
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
    });
    return json(tileset);
  } catch (e) {
    return new Response(`chunk error: ${(e as Error).message}`, { status: 500 });
  }
}

async function serveTile(src: string, url: URL): Promise<Response> {
  try {
    const { source, toEcef } = await getMeta(src);
    const key = url.pathname.slice(PREFIX.length, -'.pnts'.length);
    const node: Hierarchy.Node = {
      pointCount: Number(url.searchParams.get('c')),
      pointDataOffset: Number(url.searchParams.get('o')),
      pointDataLength: Number(url.searchParams.get('l')),
    };
    if (!node.pointCount) return new Response('empty node', { status: 404 });

    const dec = await source.decodeNode(key, node);
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
    return new Response(encodePnts(ecef, dec.colors, rtc), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  } catch (e) {
    return new Response(`tile error: ${(e as Error).message}`, { status: 500 });
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
