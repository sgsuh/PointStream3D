# PointStream3D

Stream and render **COPC** (Cloud Optimized Point Cloud) files **directly in CesiumJS** —
no server-side tiling, no pre-conversion. Point it at a `.copc.laz` URL and it renders on
the globe, with eye-dome lighting and point attenuation applied by the engine.

> KOSSA 2026 오픈소스 개발자대회 · Gaia3D 지정과제. 설계 근거와 측정 로그는
> [`docs/architecture.md`](docs/architecture.md) 참고.

## How it works

A Service Worker intercepts tile requests and transcodes the COPC octree into 3D Tiles on
the fly — tileset documents and `pnts` tiles, generated only for what the camera asks for.
That means **Cesium drives level of detail, frustum culling, request scheduling and
memory**, and its point-cloud shading applies to our tiles for free. Large files stay lazy:
each COPC hierarchy page becomes an external tileset the worker resolves on demand, so only
the visible part of the octree is ever fetched.

## Install

```bash
npm install pointstream3d cesium
```

`cesium` is a peer dependency — it is never bundled.

### Serve the two runtime assets

The package ships a prebuilt Service Worker and the laz-perf WASM. Both must be served by
your app, **side by side** (the worker resolves the wasm relative to its own URL):

```
node_modules/pointstream3d/dist/pointstream3d-sw.js
node_modules/pointstream3d/dist/laz-perf.wasm
```

Copy them into your static directory (e.g. `public/`) as a build step:

```json
{
  "scripts": {
    "postinstall": "cp node_modules/pointstream3d/dist/{pointstream3d-sw.js,laz-perf.wasm} public/"
  }
}
```

> **Scope matters.** A Service Worker only receives fetch events from pages inside its
> scope, so serve `pointstream3d-sw.js` from your app's base path — the site root for a
> root-served app, or `/my-app/` for a project site. To serve it from a narrower path
> anyway, widen the scope with a `Service-Worker-Allowed` response header.
>
> Service Workers also require a secure context: `https`, or `http://localhost` in
> development.

## Usage

```ts
import { Viewer } from 'cesium';
import { COPCPointCloud } from 'pointstream3d';

const viewer = new Viewer('cesiumContainer');

const cloud = await COPCPointCloud.fromUrl('/data/autzen.copc.laz');
viewer.scene.primitives.add(cloud.tileset);
await viewer.zoomTo(cloud.tileset);
```

`cloud.tileset` is a plain `Cesium3DTileset`, so everything you already know applies —
`tileset.style`, picking, `allTilesLoaded`, and the rest.

Call `cloud.destroy()` when you're done: it destroys the tileset and tells the worker to
drop its cached header and hierarchy pages for that file, which nothing else evicts.

### Colour modes

```ts
const cloud = await COPCPointCloud.fromUrl(url, {
  colorMode: 'rgb',
  attributes: ['height', 'intensity', 'classification'], // carry these for later
});

cloud.colorMode = 'elevation'; // instant — no tiles refetched
```

| mode | needs attribute | notes |
|---|---|---|
| `rgb` | — | the file's own colour; no style at all |
| `elevation` | `height` | auto-ranged from the file's header |
| `intensity` | `intensity` | auto-ranged from the root node, since LAS has no header field for it |
| `classification` | `classification` | ASPRS standard classes (LAS 1.4) |

`colorMode` defaults to `rgb` when the file carries colour and `elevation` when it does
not, so a file with no RGB renders usefully out of the box.

Styling runs on the GPU from a per-point batch table, so **switching mode refetches
nothing** — verified by `scripts/smoke-colormode.mjs`. The catch is that a mode's attribute
has to be present in the tiles: `fromUrl` requests whatever the initial `colorMode` needs,
so list any mode you might switch to in `attributes` up front. Switching to a mode whose
attribute is missing throws rather than rendering silently wrong.

Attributes cost bytes per point — `height` 4, `intensity` 2, `classification` 1, against 15
for position and colour. Carrying all three grew autzen's loaded geometry from 17.7 MB to
25.9 MB (+47%) at the same camera, so request only the modes you actually offer.

Elevation is coloured from an explicit `Height` property rather than the point's position
because the styling language's `${POSITION}` is tile-local, and every tile carries its own
`RTC_CENTER` — a ramp built on it would restart at each tile boundary.

### Options

```ts
const cloud = await COPCPointCloud.fromUrl(url, {
  serviceWorker: { url: '/pointstream3d-sw.js' },
  maximumScreenSpaceError: 4,
  pointCloudShading: { eyeDomeLighting: true, geometricErrorScale: 1.5 },
  cacheBytes: 512 * 1024 * 1024,
});
```

| option | default | notes |
|---|---:|---|
| `serviceWorker.url` | `pointstream3d-sw.js` next to the document base | set `register: false` if your app registers it |
| `colorMode` | `rgb`, or `elevation` with no RGB | see above |
| `attributes` | what `colorMode` needs | extra per-point attributes to carry for later switching |
| `maximumScreenSpaceError` | `4` | pixels of allowed error before a tile refines |
| `maxTilesPerChunk` | `512` | tiles per generated tileset document before deeper nodes are delegated |
| `pointCloudShading.attenuation` | `true` | required for eye-dome lighting to do anything |
| `pointCloudShading.eyeDomeLighting` | `true` | |
| `pointCloudShading.geometricErrorScale` | `1.5` | splat size relative to point spacing; `1.0` leaves holes |
| `pointCloudShading.maximumAttenuation` | `8` | pixel cap on point size |
| `cacheBytes` / `maximumCacheOverflowBytes` | 512 MB | the point budget: bytes of tile content kept before eviction |
| `dynamicScreenSpaceError` | `false` | only pays off on data much larger than the view |

Defaults are measured, not guessed — see [`docs/architecture.md` §8.1](docs/architecture.md)
for the sweeps behind them. `COPC_DEFAULTS` is exported if you want to build on them.

Note that `geometricError` is emitted as the true point spacing **in metres**, measured
through the reprojection, so these numbers mean the same thing across datasets whatever the
source CRS units are. Cesium's own default of `16` is far too coarse against an accurate
value.

## Development

Everything runs in Docker — no local Node/npm needed.

```bash
# Download public COPC samples into public/data/ (git-ignored)
docker compose run --rm web sh scripts/fetch-data.sh

# Build the Service Worker bundle, then start the dev server -> http://localhost:5173
docker compose run --rm web npm run build:sw
docker compose up -d

# Build the library (dist/), the demo site (dist-demo/), or type-check
docker compose run --rm web npm run build
docker compose run --rm web npm run build:demo
docker compose run --rm web npm run typecheck

# Headless data-pipeline check (no browser): decode + reproject
docker compose run --rm web npm run smoke public/data/autzen.copc.laz

# Report a file's hierarchy pages and cube-vs-data extent
docker compose run --rm web node scripts/probe-copc.mjs public/data/autzen.copc.laz
```

Demo pages: `tiles.html` is the library demo; `index.html` is the original
`PointPrimitiveCollection` PoC that proved the data pipeline.

### Streaming a large remote file

Remote COPC files are proxied as same-origin (Range-forwarded) so the browser can stream
them without CORS or a full download. `sofi.copc.laz` — 364M points, 2 GB, 111 hierarchy
sub-pages — straight from S3:

```
http://localhost:5173/tiles.html?src=/remote-s3/hobu-lidar/sofi.copc.laz&zoom=0.05
```

### Headless render verification

Screenshots the running app via the official Puppeteer image (SwiftShader WebGL), attached
to the compose network, and dumps LOD metrics from `Cesium3DTileset.statistics`:

```bash
mkdir -p poc-out && chmod 777 poc-out
docker run --rm --network pointstream3d_default \
  -e TARGET_URL="http://web:5173/tiles.html" -e OUT=/out/x.png \
  -v "$PWD/scripts:/home/pptruser/work:ro" -v "$PWD/poc-out:/out" \
  -w /home/pptruser/work --entrypoint node \
  ghcr.io/puppeteer/puppeteer:latest screenshot.mjs
```

Check that colour-mode switching refetches nothing:

```bash
docker run --rm --network pointstream3d_default \
  -e TARGET_URL="http://web:5173/tiles.html" \
  -v "$PWD/scripts:/home/pptruser/work:ro" \
  -w /home/pptruser/work --entrypoint node \
  ghcr.io/puppeteer/puppeteer:latest smoke-colormode.mjs
```

The demo exposes every LOD knob as a query parameter (`?sse=`, `?ges=`, `?mt=`, `?cache=`,
`?dyn=`), plus `?color=` and `?attrs=0` (drop per-point attributes, to measure their cost)
and `?cam=lon,lat,height,heading,pitch`. **Pin `?cam=` for any A/B run** —
`zoomTo()` frames from the root bounding volume, so changing a bounding volume silently
reframes the shot and invalidates the comparison. `screenshot.mjs` prints a reusable `cam`
string.

## Layout

```
src/index.ts              public entry point
src/COPCPointCloud.ts     public API: COPCPointCloud.fromUrl(), options, defaults
src/sw/sw.ts              Service Worker: serves tileset.json / page.json / *.pnts
src/core/
  CopcSource.ts           copc.js wrapper: HTTP-range getter, hierarchy, node decode
  tileset.ts              COPC hierarchy page -> 3D Tiles chunk + external tilesets
  bounds.ts               node cube -> tight oriented box, clamped to real extent
  georef.ts / ecef.ts     Cesium-free reprojection (runs inside the worker)
  pnts.ts                 pnts encoder (RTC_CENTER, float32)
  wkt.ts                  WKT helpers: compound-CRS extraction, feet -> metre
scripts/                  build-sw, smoke, probe-copc, screenshot (headless harness)
docs/architecture.md      architecture decision + verification and tuning log
```

## Sample data

| file | size | notes |
|------|------|-------|
| `ellipsoid.copc.laz` | ~0.6 MB | synthetic, fast smoke test (WGS84 Pseudo-Mercator) |
| `autzen.copc.laz` | ~81 MB | real LiDAR, Autzen Stadium OR (compound CRS: NAD83 Oregon Lambert ft + NAVD88 ftUS); single hierarchy page |
| `sofi.copc.laz` | 2.03 GB | remote; 364M points, 111 sub-pages, no RGB — the multi-page test case |

## License

MIT
