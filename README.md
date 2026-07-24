# PointStream3D

Stream and render **COPC** (Cloud Optimized Point Cloud) files **directly in CesiumJS** —
no server-side tiling, no pre-conversion. Point a browser at a `.copc.laz` file and see it
on the globe.

> KOSSA 2026 오픈소스 개발자대회 · Gaia3D 지정과제. 설계 근거는 [`docs/architecture.md`](docs/architecture.md) 참고.

## Status: Week 0 PoC ✅

The end-to-end data path is validated: `copc.js` range-reads a COPC file, `laz-perf` (WASM)
decodes it in the browser, the source CRS is reprojected to ECEF, and points render on the
CesiumJS globe. Verified headlessly against real geolocated LiDAR (Autzen Stadium, Oregon):

```
Done — 300,000 points from 9 octree nodes (depth ≤ 3)
```

Two render paths exist:

- **`index.html`** — simple `PointPrimitiveCollection` PoC (proves the data pipeline).
- **`tiles.html`** — the **chosen architecture**: a Service Worker transcodes COPC octree
  nodes to `pnts` on the fly, and `Cesium3DTileset` streams them with **Eye-Dome Lighting +
  attenuation applied by the engine for free**. This is the make-or-break for Option A —
  validated headlessly. Scales to large files via **lazy external tilesets**: each COPC
  hierarchy page (and every `CHUNK_LEVELS` boundary) becomes a `page.json` external tileset
  the SW serves on demand, so only the visible octree is fetched.

Build the Service Worker bundle before opening `tiles.html`:

```bash
docker compose run --rm web npm run build:sw     # -> public/copc-sw.js + public/laz-perf.wasm
# then open http://localhost:5173/tiles.html
```

> Service Workers need a secure context: `http://localhost` works; other hosts don't.

### Streaming a large remote file (multi-page)

Remote COPC files are proxied as same-origin (Range-forwarded) so the browser can
stream them without CORS or a full download. Example: `sofi.copc.laz` (364M points,
2 GB, 111 hierarchy sub-pages) streamed straight from S3:

```
http://localhost:5173/tiles.html?src=/remote-s3/hobu-lidar/sofi.copc.laz&zoom=0.05&sse=2
```

The Service Worker lazily loads only the hierarchy pages and nodes the view needs.
Validate the sub-page path headlessly (no browser, range reads only):

```bash
docker compose run --rm web node scripts/smoke-subpage.mjs
docker compose run --rm web node scripts/probe-copc.mjs <copc-url>   # report sub-page count
```

## Everything runs in Docker

No local Node/npm needed — the toolchain lives in the container.

```bash
# 1) Download public COPC samples into public/data/ (git-ignored)
./scripts/fetch-data.sh          # or run inside the container, see below

# 2) Start the Vite dev server  ->  http://localhost:5173
docker compose up --build

# 3) Headless data-pipeline check (no browser): decode + reproject a file
docker compose run --rm web npm run smoke public/data/autzen.copc.laz

# 4) Type-check + production build
docker compose run --rm web npm run build
```

If you don't have `curl`/`bash` on the host, fetch samples inside the container:

```bash
docker compose run --rm web sh scripts/fetch-data.sh
```

### Headless render verification (optional)

Screenshots the running app via the official Puppeteer image (SwiftShader WebGL),
attached to the compose network:

```bash
mkdir -p poc-out && chmod 777 poc-out
docker run --rm --network pointstream3d_default \
  -e TARGET_URL=http://web:5173/ -e OUT=/out/poc.png \
  -v "$PWD/scripts:/home/pptruser/work:ro" -v "$PWD/poc-out:/out" \
  -w /home/pptruser/work --entrypoint node \
  ghcr.io/puppeteer/puppeteer:latest screenshot.mjs
```

## Layout

```
docs/architecture.md    Architecture decision (Option A: dynamic 3D Tiles) + rationale
index.html              PoC page
src/main.ts             PoC entry: Cesium viewer, load COPC, render points
src/core/CopcSource.ts  copc.js wrapper: HTTP-range getter, hierarchy, node decode
src/core/reproject.ts   source CRS (WKT) -> ECEF via proj4
src/core/wkt.ts         WKT helpers (compound-CRS extraction, feet->metre)
scripts/smoke.mjs       headless decode + reproject check (Node)
scripts/screenshot.mjs  headless render verification (Puppeteer)
Dockerfile              node:22-slim dev/build image
docker-compose.yml      dev server + one-off commands
```

## Sample data

| file | size | notes |
|------|------|-------|
| `ellipsoid.copc.laz` | ~0.6 MB | synthetic, fast smoke test (WGS84 Pseudo-Mercator) |
| `autzen.copc.laz` | ~81 MB | real LiDAR, Autzen Stadium OR (compound CRS: NAD83 Oregon Lambert ft + NAVD88 ftUS) |

Switch which sample the PoC loads via `DATA_URL` in `src/main.ts`.

## License

TBD (planned: MIT — matches copc.js / TIFFImageryProvider).
