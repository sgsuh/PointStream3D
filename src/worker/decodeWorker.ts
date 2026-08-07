/// <reference lib="webworker" />

// One decode worker: fetches a COPC node over HTTP range, LAZ-decodes it,
// reprojects, and returns a finished `pnts` tile.
//
// It is created by the page (a Service Worker cannot create workers) but is
// driven entirely by the Service Worker, over a MessagePort the page hands over
// once. See `src/core/protocol.ts` for why.

import { MetaCache, encodeNodeTile } from '../core/tile';
import { POOL_PORT, RELEASE, type DecodeRequest, type DecodeResponse } from '../core/protocol';

declare const self: DedicatedWorkerGlobalScope;

// The wasm URL is only known to the Service Worker, so the cache cannot be built
// before the first request arrives.
let cache: MetaCache | undefined;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; src?: string } | undefined;

  if (data?.type === POOL_PORT) {
    const port = event.ports[0];
    if (port) port.onmessage = (m: MessageEvent) => serve(port, m.data as DecodeRequest);
    return;
  }

  // The page dropped a file; forget its header and CRS.
  if (data?.type === RELEASE && data.src) cache?.release(data.src);
});

async function serve(port: MessagePort, request: DecodeRequest): Promise<void> {
  const reply = (response: DecodeResponse, transfer: Transferable[] = []) =>
    port.postMessage(response, transfer);
  try {
    cache ??= new MetaCache(request.wasmUrl);
    const meta = await cache.get(request.src);
    const tile = await encodeNodeTile(meta, request.key, request.node, request.attributes);
    reply({ id: request.id, ok: true, tile }, [tile]);
  } catch (e) {
    reply({ id: request.id, ok: false, error: (e as Error).message });
  }
}
