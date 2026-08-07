// Messages exchanged between the page, the Service Worker and the decode
// workers.
//
// The pool lives in the page because a Service Worker may not create workers:
// the HTML spec exposes `Worker` to `(Window, DedicatedWorker, SharedWorker)`
// only, so `new Worker()` in a ServiceWorkerGlobalScope is a ReferenceError in
// every browser, by design. The page therefore spawns the workers and hands the
// Service Worker one MessagePort per worker, after which the two talk directly.
//
// Routing through the page's `message` handler instead would work, but puts the
// main thread — the one Cesium renders on — in the path of every tile. Measured
// with a 4 MB payload while the main thread was deliberately busy for 1 s: the
// direct port answered in 0.2 ms, the page-proxied hop in 1001.7 ms.

import type { COPCAttribute } from './CopcSource';

/** Page -> Service Worker, transferring one port; and page -> worker likewise. */
export const POOL_PORT = 'pointstream3d:pool-port';
/** Service Worker -> page, after a worker restart lost the ports it was given. */
export const NEED_PORTS = 'pointstream3d:need-ports';
/** Page -> Service Worker: drop cached state for a file, and this pool's ports. */
export const RELEASE = 'pointstream3d:release';

/** Service Worker -> decode worker, over the handed-over port. */
export interface DecodeRequest {
  id: number;
  /** Absolute URL of the COPC file. */
  src: string;
  /** Octree key, `d-x-y-z`. */
  key: string;
  node: { pointCount: number; pointDataOffset: number; pointDataLength: number };
  attributes: COPCAttribute[];
  /** Where the worker should load laz-perf from; only the SW knows this. */
  wasmUrl: string;
}

/** Decode worker -> Service Worker. `tile` is transferred, not copied. */
export type DecodeResponse =
  | { id: number; ok: true; tile: ArrayBuffer }
  | { id: number; ok: false; error: string };
