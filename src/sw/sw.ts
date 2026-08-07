/// <reference lib="webworker" />
import type { Hierarchy } from 'copc';
import type { CopcSource, COPCAttribute } from '../core/CopcSource';
import { buildPageTileset } from '../core/tileset';
import { MetaCache, encodeNodeTile } from '../core/tile';
import {
  NEED_PORTS,
  POOL_PORT,
  RELEASE,
  type DecodeRequest,
  type DecodeResponse,
} from '../core/protocol';

// Service Worker that transcodes a COPC file into 3D Tiles on the fly, one
// hierarchy page at a time (external tilesets) so it scales to huge files:
//   GET <scope>copc-tiles/tileset.json?src=<url>            -> root chunk
//   GET <scope>copc-tiles/page.json?src=<url>&key=&o=&l=    -> a sub-page chunk (external tileset)
//   GET <scope>copc-tiles/<l-x-y-z>.pnts?src=<url>&o=&l=&c= -> one node as `pnts`
// Cesium's Cesium3DTileset drives LOD/culling/memory and applies point-cloud
// shading (EDL) to our tiles for free.
//
// Tiles are decoded in a pool of page-owned workers reached over MessagePorts
// (see `src/core/protocol.ts`); this thread only routes. With no pool it decodes
// inline, exactly as it used to.

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

const metaCache = new MetaCache(WASM_URL);
const getMeta = (src: string) => metaCache.get(src);

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

// --- Decode pool -----------------------------------------------------------

interface PoolWorker {
  port: MessagePort;
  poolId: string;
  /** Requests sent and not yet answered, so work goes to the idlest worker. */
  inflight: number;
}

// A worker that never answers must not hold a tile request open forever. Well
// past the worst node seen (a few seconds), so only a genuinely dead port trips
// it.
const DECODE_TIMEOUT_MS = 60_000;
/** Re-handshake requests are broadcast at most this often. */
const PORT_REQUEST_INTERVAL_MS = 2_000;

const pool: PoolWorker[] = [];
const pending = new Map<number, (response: DecodeResponse) => void>();
let nextRequestId = 1;
let lastPortRequest = 0;

/**
 * Where tile decoding actually went, served at `<scope>copc-tiles/stats.json`.
 * Diagnostics only — the answer to "is the pool being used, and is decoding what
 * the load is even waiting on?" is otherwise invisible from the page.
 */
const stats = {
  poolDecodes: 0,
  poolDecodeMs: 0,
  inlineDecodes: 0,
  inlineDecodeMs: 0,
  /** Pool decodes that threw and were retried inline. */
  fallbacks: 0,
};

async function timed(kind: 'pool' | 'inline', work: Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  const started = performance.now();
  try {
    return await work;
  } finally {
    const ms = performance.now() - started;
    if (kind === 'pool') {
      stats.poolDecodes++;
      stats.poolDecodeMs += ms;
    } else {
      stats.inlineDecodes++;
      stats.inlineDecodeMs += ms;
    }
  }
}

function attachPort(port: MessagePort, poolId: string): void {
  const worker: PoolWorker = { port, poolId, inflight: 0 };
  port.onmessage = (event: MessageEvent) => {
    const response = event.data as DecodeResponse;
    worker.inflight = Math.max(0, worker.inflight - 1);
    const settle = pending.get(response.id);
    if (settle) {
      pending.delete(response.id);
      settle(response);
    }
  };
  pool.push(worker);
}

function dropWorker(worker: PoolWorker): void {
  const i = pool.indexOf(worker);
  if (i >= 0) pool.splice(i, 1);
}

/**
 * The browser may stop an idle Service Worker; the restarted one has no ports.
 * Ask the pages to hand them over again — the tile that noticed is served inline
 * meanwhile, so nothing waits on the round trip.
 */
function requestPorts(): void {
  const now = Date.now();
  if (now - lastPortRequest < PORT_REQUEST_INTERVAL_MS) return;
  lastPortRequest = now;
  void self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) client.postMessage({ type: NEED_PORTS });
  });
}

/** Returns null when there is no pool to dispatch to. */
function decodeInPool(request: Omit<DecodeRequest, 'id'>): Promise<ArrayBuffer> | null {
  if (!pool.length) return null;
  const worker = pool.reduce((a, b) => (b.inflight < a.inflight ? b : a));
  const id = nextRequestId++;
  worker.inflight++;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      dropWorker(worker);
      reject(new Error('decode worker did not respond'));
    }, DECODE_TIMEOUT_MS);
    pending.set(id, (response) => {
      clearTimeout(timer);
      if (response.ok) resolve(response.tile);
      else reject(new Error(response.error));
    });
    worker.port.postMessage({ ...request, id } satisfies DecodeRequest);
  });
}

self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; src?: string; poolId?: string } | undefined;

  if (data?.type === POOL_PORT && event.ports[0] && data.poolId) {
    attachPort(event.ports[0], data.poolId);
    return;
  }

  // A page releases a file's metadata and parsed hierarchy pages when its point
  // cloud is destroyed, and its workers when the last cloud using them goes.
  // Nothing else evicts either: they are keyed by source URL and pool id and
  // live as long as the worker does.
  if (data?.type !== RELEASE) return;
  if (data.poolId) {
    for (const worker of pool.filter((w) => w.poolId === data.poolId)) dropWorker(worker);
  }
  if (data.src) {
    metaCache.release(data.src);
    for (const key of [...pageCache.keys()]) {
      if (key.startsWith(`${data.src}|`)) pageCache.delete(key);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;

  if (url.pathname === `${PREFIX}stats.json`) {
    event.respondWith(json({ ...stats, poolSize: pool.length }));
    return;
  }

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
  const attributes = attributesFrom(url);
  const key = url.pathname.slice(PREFIX.length, -'.pnts'.length);
  const node: Hierarchy.Node = {
    pointCount: Number(url.searchParams.get('c')),
    pointDataOffset: Number(url.searchParams.get('o')),
    pointDataLength: Number(url.searchParams.get('l')),
  };
  if (!node.pointCount) return new Response('empty node', { status: 404 });

  const inPool = decodeInPool({ src, key, node, attributes, wasmUrl: WASM_URL });
  if (inPool) {
    try {
      return tile(await timed('pool', inPool));
    } catch (e) {
      stats.fallbacks++;
      // A dead port has already been dropped; decoding here still answers this
      // request, and a real decode failure surfaces below with the same message.
      console.warn('[PointStream3D] decode worker failed, falling back:', (e as Error).message);
    }
  } else {
    requestPorts();
  }

  try {
    const meta = await getMeta(src);
    return tile(await timed('inline', encodeNodeTile(meta, key, node, attributes)));
  } catch (e) {
    return new Response(`tile error: ${(e as Error).message}`, { status: 500 });
  }
}

function tile(body: ArrayBuffer): Response {
  return new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
