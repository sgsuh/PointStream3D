// Page-side pool of decode workers.
//
// The Service Worker does the LAZ decoding on its single thread unless it is
// given somewhere better to do it. It cannot create workers itself, so the page
// creates them and hands over one MessagePort each; from then on the Service
// Worker talks to the workers directly. See `src/core/protocol.ts`.

import { NEED_PORTS, POOL_PORT, RELEASE } from './core/protocol';

/**
 * Leave a core for the page: Cesium's own rendering, tile transcoding and the
 * Service Worker all want one, and decoding is only part of the pipeline.
 */
export function defaultWorkerCount(): number {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(6, cores - 1));
}

let nextPoolId = 1;
let listening = false;

/** Pools are shared by worker URL, so two point clouds do not double the threads. */
const live = new Map<string, { pool: DecodePool; refs: number }>();

export class DecodePool {
  readonly id = `pool-${nextPoolId++}`;
  private workers: Worker[] = [];

  constructor(
    readonly url: string,
    count: number,
  ) {
    for (let i = 0; i < count; i++) this.workers.push(new Worker(url, { type: 'module' }));
    this.handOver();
  }

  get size(): number {
    return this.workers.length;
  }

  /**
   * Wire every worker to the active Service Worker with a fresh MessageChannel.
   * Run again whenever the Service Worker restarts — the browser is free to stop
   * an idle one, and it comes back with no ports.
   */
  handOver(): void {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;
    for (const worker of this.workers) {
      const channel = new MessageChannel();
      worker.postMessage({ type: POOL_PORT }, [channel.port2]);
      sw.postMessage({ type: POOL_PORT, poolId: this.id }, [channel.port1]);
    }
  }

  /** Drop a file's cached header and CRS in every worker. */
  release(src: string): void {
    for (const worker of this.workers) worker.postMessage({ type: RELEASE, src });
  }

  private destroy(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }

  static acquire(url: string, count: number): DecodePool {
    listen();
    let entry = live.get(url);
    if (!entry) {
      entry = { pool: new DecodePool(url, count), refs: 0 };
      live.set(url, entry);
    }
    entry.refs++;
    return entry.pool;
  }

  static release(pool: DecodePool): void {
    const entry = live.get(pool.url);
    if (!entry || entry.pool !== pool) return;
    if (--entry.refs > 0) return;
    live.delete(pool.url);
    entry.pool.destroy();
    navigator.serviceWorker?.controller?.postMessage({ type: RELEASE, poolId: pool.id });
  }
}

function listen(): void {
  if (listening || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  listening = true;
  const rewire = () => {
    for (const { pool } of live.values()) pool.handOver();
  };
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === NEED_PORTS) rewire();
  });
  // A new Service Worker taking over has no ports either.
  navigator.serviceWorker.addEventListener('controllerchange', rewire);
}
