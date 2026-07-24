import { createLazPerf } from 'laz-perf/lib/web';

// One shared laz-perf (WASM) instance per wasm URL. The URL is injected so this
// module works both under Vite (`?url` asset) and in the esbuild-bundled Service
// Worker (a plain `/laz-perf.wasm` public path).
const instances = new Map<string, Promise<any>>();

export function getLazPerf(wasmUrl: string): Promise<any> {
  let inst = instances.get(wasmUrl);
  if (!inst) {
    inst = Promise.resolve(createLazPerf({ locateFile: () => wasmUrl }));
    instances.set(wasmUrl, inst);
  }
  return inst;
}
