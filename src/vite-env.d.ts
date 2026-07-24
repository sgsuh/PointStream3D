/// <reference types="vite/client" />

// Vite emits the wasm as an asset URL when imported with `?url`.
declare module '*.wasm?url' {
  const src: string;
  export default src;
}
