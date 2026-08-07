# PointStream3D — 렌더링 아키텍처 설계 문서

> CesiumJS 위에서 COPC(Cloud Optimized Point Cloud) 파일을 **사전 변환 없이** 스트리밍 렌더링하는 라이브러리의 아키텍처 결정 및 설계.
> 상태: **Draft v1** · 작성일 2026-07-24 · 근거: 4개 병렬 기술조사(COPC/copc.js, Cesium 렌더링 내부, 선행사례, 렌더 품질)

---

## 1. 결론 (TL;DR)

| 결정 항목 | 채택 | 이유 |
|-----------|------|------|
| **렌더링 아키텍처** | **A) 동적 3D Tiles** (`Cesium3DTileset`에 런타임 생성 타일 공급) | Cesium 엔진이 LOD·프러스텀 컬링·요청 스케줄링·GPU 메모리 관리 + **EDL·포인트 감쇠·속성 스타일링**을 전부 무료 제공 |
| **콘텐츠 공급 방식** | **Service Worker 트랜스코더** (COPC 노드 → `pnts`/glTF 온더플라이) | Cesium엔 타일별 콘텐츠 콜백이 없음 → lazy 스트리밍은 fetch 가로채기가 유일한 클라이언트-온리 해법 |
| **옥트리 매핑** | 3D Tiles **Implicit Tiling(octree)** | COPC 자체가 Morton 옥트리 → 1:1 매핑, 매니페스트 최소화 |
| **COPC 파싱** | **copc.js** (MIT) + laz-perf WASM, **Web Worker 풀**에서 실행 | 검증된 리더(iTowns·Giro3D도 사용). 얇지만 정확 |
| **패키징 템플릿** | **TIFFImageryProvider** 구조 | 과제가 명시한 품질 기준. `static fromUrl()`, cesium peerDep, 워커풀, 데모 |

**한 줄 요약**: *"Eptium(클로즈드)이 하는 in-browser COPC→3D Tiles를, 오픈소스 라이브러리로 재현한다."*

---

## 2. 요구사항 & 제약

- **입력**: 단일 `.copc.laz` 파일 (로컬 or S3/CDN 원격, HTTP Range 지원)
- **사전 타일링 변환 없음** — 원본을 그대로 웹에 즉시 표시 (과제 핵심)
- **대용량**: 수억~수십억 포인트에서 부드러운 인터랙션
- **CesiumJS 씬 통합**: 지형·건물·이미지 레이어와 겹쳐보기 (Cesium 생태계 이점 = 우리 차별화)
- **품질 기준**: Potree / Eptium 수준 (EDL, 컬러 모드, 적응형 포인트 크기)
- **라이브러리 형태**: `TIFFImageryProvider`급 — TypeScript, npm 배포, 타입 정의, 데모, 문서

---

## 3. 아키텍처 옵션 비교

세 가지 렌더링 경로를 검토했다.

### 옵션 A — 동적 3D Tiles (`Cesium3DTileset`)
COPC 옥트리를 런타임 생성 3D Tiles 트리로 매핑하고, Cesium의 타일셋 엔진이 렌더링을 주도.

### 옵션 B — 커스텀 Primitive (`DrawCommand`)
copc.js로 노드를 직접 fetch·디코드하여 `Float32Array` → 커스텀 셰이더/`DrawCommand`로 직접 렌더. LOD·컬링·메모리·EDL을 모두 자체 구현.

### 옵션 C — `PointPrimitiveCollection` — ❌ 기각
`add()`/`remove()`가 O(n) 버퍼 재업로드를 유발하고, LOD·컬링·EDL이 전무. 수천 개 마커용이지 수백만 포인트 클라우드용이 아님. **초기 PoC 스케치 용도 외 사용 안 함.**

### 결정 매트릭스 (A vs B)

| 기능 | A) 동적 3D Tiles | B) 커스텀 Primitive |
|------|------------------|---------------------|
| LOD 선택(SSE) | ✅ 내장 (`maximumScreenSpaceError`, `skipLevelOfDetail`) | ❌ 직접 구현 |
| 프러스텀 컬링 | ✅ 내장 (타일 바운딩 볼륨) | ❌ 직접 구현 |
| 요청 스케줄링/스로틀 | ✅ 내장 (Cesium request scheduler, `foveatedScreenSpaceError`) | ❌ 직접 구현 |
| GPU 메모리 관리/eviction | ✅ 내장 (`cacheBytes`) | ❌ 직접 구현 |
| **Eye-Dome Lighting** | ✅ 내장 (`pointCloudShading.eyeDomeLighting`) | ❌ MRT + 포스트프로세스 직접 구현 |
| 포인트 크기 감쇠 | ✅ 내장 (geometric-error 기반) | ❌ 셰이더에 직접 |
| 속성별 컬러(RGB/분류/고도) | ✅ 내장 (`Cesium3DTileStyle`, 런타임) | ❌ GLSL 직접 |
| 피킹/메타데이터 | ✅ 내장 (`EXT_mesh_features`, `pickPosition`) | ❌ 직접 |
| **콘텐츠 공급 난이도** | ⚠️ **어려움** — Cesium이 fetch 주도, 콜백 없음 → SW/서버 필요 | ✅ 쉬움 — 디코드→GPU 직접 |
| 렌더 API 안정성 | ✅ 공개·지원 API | ⚠️ private·불안정 (`DrawCommand` 등) |

**판정: A 채택.** 과제의 품질 기준(EDL·LOD·감쇠·스타일링)이 전부 `Cesium3DTileset`에 하드와이어되어 있어, A는 세 줄의 프로퍼티 설정으로 프로급 렌더링을 상속받는다. B는 그 전부를 **불안정한 private API 위에서** 재구현해야 한다. A의 유일한 난제는 "런타임 COPC 콘텐츠를 어떻게 엔진에 넣느냐"인데, 이건 국소적이고 해결 가능한 문제다(§4).

> **핵심 통찰**: 우리의 엔지니어링 예산은 *스트리밍 포인트 클라우드 엔진을 다시 만드는 데*(B) 쓰는 게 아니라, *COPC→타일 브리지 하나*(A)에 집중하는 게 옳다.

---

## 4. 콘텐츠 공급 방식 — 이 프로젝트의 핵심 결정

Cesium3DTileset의 근본 제약을 먼저 명확히 한다:

> **Cesium3DTileset에는 "이 타일의 바이트를 넘겨줘" 하는 공개 콜백이 없다.** 자식 타일 콘텐츠는 각 타일의 `content.uri`를 base URL 기준으로 해석해 Cesium 요청 스케줄러(fetch/XHR)가 직접 가져온다.

여기서 파생되는 결정적 사실:

> **`blob:`/`data:` URI는 "지금 메모리에 존재하는 바이트"를 가리킨다.** 따라서 모든 콘텐츠를 blob URL로 넣으려면 **모든 노드를 미리 디코드**해야 하고, 이는 lazy 스트리밍이 아니다. 진짜 lazy 스트리밍은 **Cesium이 URL을 fetch하는 순간을 가로채는 것**이 유일한 방법이다.

### 후보 3가지

| 방식 | 동작 | lazy? | 서버 불필요? | 평가 |
|------|------|:-----:|:-----:|------|
| **1. Explicit + blob URI** | 옥트리 전체를 tileset.json으로 만들고 각 노드 content.uri=blob URL | ❌ (선디코드 필요) | ✅ | 소용량 데모/PoC엔 OK, 대용량 스트리밍 불가 |
| **2. Service Worker 트랜스코더** ⭐ | SW가 `/{level}/{x}/{y}/{z}.pnts` 요청을 가로채 copc.js로 해당 노드만 fetch·디코드·인코딩해 응답 | ✅ | ✅ | **채택**. Eptium의 사실상 설계. 완전 lazy, 클라이언트-온리 |
| **3. 로컬/원격 트랜스코드 서버** | 서버가 COPC 노드 → pnts 변환 엔드포인트 제공 | ✅ | ❌ | "사전 변환 없음" 취지엔 맞지만 서버 의존 → 라이브러리 성격과 안 맞음 |

### 채택: 방식 2 — Service Worker 트랜스코더 (+ Implicit Octree Tiling)

```
Cesium3DTileset
  └─ tileset.json (implicit octree, subtree URI 템플릿)   ← 가상, SW가 생성
       └─ 타일 콘텐츠 요청: /copc/{level}/{x}/{y}/{z}.pnts  ← SW가 가로챔
                                    │
                         ┌──────────▼───────────┐
                         │   Service Worker      │
                         │  1. VoxelKey 파싱      │
                         │  2. copc.js: 노드 데이터 range-fetch │
                         │  3. laz-perf: LAZ 디코드 │
                         │  4. CRS→ECEF 재투영(RTC) │
                         │  5. pnts/glTF 인코딩     │
                         │  6. Response 반환        │
                         └──────────────────────┘
```

- **Implicit Tiling(octree)**을 쓰는 이유: COPC의 `VoxelKey{level,x,y,z}`(Morton 옥트리)와 3D Tiles implicit의 `{level}/{x}/{y}/{z}` 주소가 거의 1:1. tileset.json은 최소 크기로 고정되고, availability subtree도 SW가 COPC 계층에서 생성해 응답.
- **SW가 COPC의 계층/데이터 range-read를 대신 수행** → 메인 스레드는 렌더에만 집중. 디코드(CPU 무거움)도 SW(워커 컨텍스트)에서 오프로드.
- **트레이드오프(정직하게)**: SW는 인라인 번들이 안 됨(동일 출처 파일 필요, HTTPS 필요). 라이브러리 소비자는 SW 파일을 서빙하고 스코프를 설정해야 함 → `registerPointStreamSW()` 헬퍼 + 문서로 마찰 최소화. (TIFFImageryProvider가 web worker를 인라인 번들하는 것과 달리 SW는 이 부분이 다르다는 점을 README에 명시.)

> **✅ 검증됨 (2026-07-24, Week 0)**: 이 SW 경로를 실제로 구현·검증했다. SW가 `/copc-tiles/tileset.json`과 노드별 `/copc-tiles/{key}.pnts`를 온더플라이로 응답하고, `Cesium3DTileset.fromUrl`이 이를 소비해 Autzen 실데이터를 렌더링. **`pointCloudShading.eyeDomeLighting`/`attenuation`이 우리 타일에 그대로 적용됨을 헤드리스 스크린샷으로 확인** → Option A의 "엔진 재사용" 전제가 실증됨. 구현: `src/sw/sw.ts`(esbuild ESM 번들 → `public/copc-sw.js`), `src/core/{pnts,tileset,georef,ecef}.ts`. 데모 페이지: `tiles.html`. 주의점: (1) SW는 보안 컨텍스트(HTTPS/localhost) 필요, (2) 헤드리스 검증 시 Chromium `--unsafely-treat-insecure-origin-as-secure` 플래그.

> **✅ 대용량 대응 — external tileset lazy 로딩 (2026-07-24)**: implicit tiling 대신 **COPC hierarchy page ↔ 3D Tiles external tileset** 매핑을 채택. COPC hierarchy는 이미 page 단위로 페이지네이션되어 있어(`pointCount === -1` = sub-page 포인터), 자식이 페이지 경계(또는 `CHUNK_LEVELS` 인위 경계)를 넘으면 SW가 `page.json?...` external tileset 타일을 emit → Cesium이 그 영역을 refine할 때만 해당 sub-page를 로드. **모든 노드/페이지 주소는 URL 파라미터(`o/l/c`)로 stateless**하게 전달 → SW는 불변 메타데이터만 캐시. 검증: Autzen에서 카메라를 당기자 root tileset 1 + **external page.json 24 + pnts 38**이 lazy 로드되고 스티칭이 이음매 없이 연속 렌더됨(헤드리스). implicit tiling의 초소형 정적 매니페스트 이점은 "SW가 매 요청 JSON 생성" 구조에선 무의미하므로 external tileset이 더 단순·견고. 구현: `src/core/tileset.ts`(`buildPageTileset`), `src/sw/sw.ts`.

> **✅ 실제 multi-page 파일로 자연 sub-page 검증 (2026-07-24)**: `sofi.copc.laz`(**364M 포인트, 2.03GB, 루트 페이지 2599 노드 + sub-page 111개**)로 확인. (1) 헤드리스 데이터 스모크(`scripts/smoke-subpage.mjs`): 루트 페이지 → `pages['4-3-3-1']` 포인터 추적 → sub-page 로드(87 노드) → 노드 디코드(19,164 pts). (2) 브라우저 end-to-end: **Vite proxy(`/remote-s3/…`)로 S3를 same-origin 노출**(2GB 파일을 range 스트리밍, CORS·풀다운로드 회피), SW가 렌더 중 **distinct COPC page 3개**(루트 + 실제 sub-page ≥2)를 lazy 로드하고 EDL로 정상 렌더. → external tileset 방식이 임의 대용량 파일에 대해 실증됨.

### 폴백/에스케이프 해치
- **소용량·오프라인 데모**: 방식 1(explicit+blob)을 "간이 모드"로 함께 제공 → SW 없이도 동작하는 경로 확보(PoC·CI 테스트·저사양 환경).
- **최후 폴백**: A 경로가 특정 환경에서 막히면 옵션 B(커스텀 primitive)로 렌더러 인터페이스만 갈아끼울 수 있도록 **렌더러 추상화 계층**을 둔다(§5).

---

## 5. 컴포넌트 설계

**현재 구현된 구조** (계획이 아니라 실제 파일):

```
src/
├─ index.ts                 공개 진입점 (re-export만)
├─ COPCPointCloud.ts        공개 API: fromUrl(), 옵션 타입, COPC_DEFAULTS
├─ sw/sw.ts                 Service Worker: tileset.json / page.json / *.pnts 응답 + 풀 라우팅
├─ decodePool.ts            페이지 소유 디코드 워커 풀 (URL별 공유, ref-count)
├─ worker/decodeWorker.ts   디코드 워커: range fetch → LAZ 디코드 → 재투영 → pnts
├─ core/
│  ├─ CopcSource.ts         copc.js 래핑: HTTP-range Getter, 계층 로드, 노드 디코드
│  ├─ tile.ts               노드 1개 → pnts 1개 (워커/SW 인라인 폴백이 공유)
│  ├─ protocol.ts           페이지↔SW↔워커 메시지 타입 + 포트 핸드오버 근거
│  ├─ tileset.ts            hierarchy page → 3D Tiles 청크 + external tileset (BFS 예산)
│  ├─ bounds.ts             노드 큐브 → 실 extent 클램프 + oriented box
│  ├─ pnts.ts               pnts 인코더 (RTC_CENTER, float32)
│  ├─ georef.ts / ecef.ts   Cesium 비의존 재투영 + 소스 단위→미터 측정 (SW에서 동작)
│  ├─ reproject.ts          Cesium판 재투영 (PointPrimitiveCollection PoC 전용)
│  ├─ wkt.ts                WKT 헬퍼: 복합 CRS 추출, 피트→미터
│  └─ lazperf.ts            laz-perf wasm URL 주입
└─ tiles-main.ts            데모 앱 (공개 API만 사용)
```

빌드 산출물은 셋으로 분리된다.

| 산출물 | 명령 | 내용 |
|---|---|---|
| `dist/` (배포 패키지) | `npm run build` | `pointstream3d.js`(9 kB, cesium external) + `pointstream3d-sw.js`(458 kB) + `pointstream3d-worker.js`(445 kB) + `laz-perf.wasm` + `types/` |
| `dist-demo/` | `npm run build:demo` | 데모 사이트(`index.html`, `tiles.html`) |
| `public/` | `npm run build:sw` | dev 서버용 SW + wasm |

**클라이언트 번들이 작은 이유**: copc.js·laz-perf·proj4는 전부 Service Worker와 디코드 워커 안에만 있다. 페이지 쪽 코드는 Cesium하고만 대화하고, 워커는 URL로만 참조한다.

### 공개 API

```ts
const cloud = await COPCPointCloud.fromUrl('/data/autzen.copc.laz', {
  serviceWorker: { url, scope, register },
  decodePool: { count, url },     // 디코드 워커 수 (기본 코어-1, 최대 6) / 스크립트 URL
  maximumScreenSpaceError: 4,
  maxTilesPerChunk: 512,
  pointCloudShading: { attenuation, eyeDomeLighting, geometricErrorScale, maximumAttenuation, ... },
  cacheBytes: 512 * 1024 * 1024,
  dynamicScreenSpaceError: false,
});
viewer.scene.primitives.add(cloud.tileset);
await viewer.zoomTo(cloud.tileset);
cloud.destroy();   // 타일셋 파괴 + SW 측 파일 캐시 해제
```

- **`static fromUrl()`** 비동기 팩토리 (Cesium 1.104+ 관례, TIFFImageryProvider와 동일)
- **`cesium`은 peerDependency** — 절대 번들하지 않음
- **`.tileset`은 평범한 `Cesium3DTileset`**을 그대로 노출한다. 래핑하지 않으므로 `tileset.style`·피킹·이벤트 등 Cesium 지식이 전부 그대로 적용된다. 래퍼가 존재하는 이유는 두 가지뿐 — SW 등록 생명주기, 그리고 `destroy()`(SW의 파일별 헤더·계층 캐시는 소스 URL로 키잉되어 타일셋보다 오래 살아남으므로 명시적 해제가 필요).
- 기본값은 §8.1의 실측치. `COPC_DEFAULTS`로 export.

### Service Worker scope — 배포 시 제약

SW는 **자기 scope 안의 클라이언트가 낸 요청에만** fetch 이벤트를 받는다. 따라서 `pointstream3d-sw.js`는 **앱의 base path에서 서빙**되어야 한다(루트 서빙 앱이면 사이트 루트, 프로젝트 사이트면 `/앱이름/`). 더 좁은 경로에서 서빙하려면 `Service-Worker-Allowed` 헤더로 scope를 넓혀야 한다.

이에 맞춰 타일 URL과 wasm 경로를 **전부 scope 상대로** 만들었다(`self.registration.scope`, `self.location`). 루트 절대경로였다면 GitHub Pages 프로젝트 사이트에서 바로 깨진다. `--base=/PointStream3D/`로 빌드해 서브패스에서 헤드리스 검증 완료 — 타일 URL이 `/PointStream3D/copc-tiles/...`로 나가고 LOD 수치는 루트 서빙과 동일.

> 데모 빌드 주의: `vite-plugin-cesium`이 base를 출력 경로에 중복 적용해 Cesium 에셋을 `dist-demo/<base>/cesium/`에 복사한다(플러그인 버그). GitHub Pages 배포 시 해당 디렉터리를 끌어올리는 후처리가 필요하다.

---

## 6. copc.js 통합 세부 (조사 근거)

- **메타데이터 1 라운드트립**: `Copc.create(getter)`가 첫 65,536바이트만 읽어 헤더·VLR·info를 슬라이스.
- **계층 lazy 순회**: `Copc.loadHierarchyPage(getter, page)` → `{nodes, pages}`. `pointCount === -1`인 엔트리는 하위 페이지 포인터 → 필요할 때만 range-fetch(우리 순회 루프가 주도).
- **노드 데이터**: `Copc.loadPointDataView(getter, copc, node)` → **포인트당 getter 함수**(배열 아님). `view.getter('X')(i)` 형태. **우리가 루프 돌려 `Float32Array`/`Uint8Array`로 패킹**해야 함.
- **좌표**: X/Y/Z는 **scale/offset 이미 적용된 실좌표**(소스 CRS 단위). 우리가 재적용하지 않음.
- **바운딩**: `Bounds.stepTo(copc.info.cube, Key.create('l-x-y-z'))` → 노드 bbox. LOD/컬링용 SSE는 `info.spacing / 2^level`.
- **원격**: `Getter` = `(begin,end)=>Promise<Uint8Array>` 추상화. **우리 커스텀 Getter로 감싸** 캐시·인증·요청 병합 제어(권장).
- **디코드**: laz-perf WASM(~1.2MB). `createLazPerf({ locateFile })`로 wasm URL 직접 제어하고 인스턴스 공유. **포인트별 동기 디코드가 CPU 무거움 → 반드시 워커에서.**

**copc.js가 주는 것 vs 우리가 만드는 것**

| 필요 | copc.js | 우리 구현 |
|------|:------:|-----------|
| 원격 range fetch | ✅ | 캐시/인증/병합 래퍼 |
| 헤더·VLR·계층 파싱 | ✅ | lazy 순회 루프 |
| LAZ 디코드 | ✅ (laz-perf) | 워커 풀·wasm 호스팅 |
| 포인트 값 디코드 | ✅ (getter) | 타입배열 패킹 |
| 노드 bbox | ✅ (`Bounds.stepTo`) | 컬링·SSE·LOD 로직 |
| **CRS→ECEF** | ❌ (wkt 문자열만) | **proj4 + Cesium + RTC 정밀도** |
| 렌더링/타일링 | ❌ | 3D Tiles 브리지 전체 |

---

## 7. 좌표계 & 정밀도 (놓치면 안 되는 함정)

- COPC 좌표는 소스 CRS(예: UTM, Web Mercator, 지리좌표) 실좌표. **`copc.wkt`를 proj4로 파싱해 ECEF(EPSG:4978) 또는 lon/lat로 재투영** 후 Cesium에 배치. copc.js는 재투영 안 함 → **전적으로 우리 몫(글로브 통합의 최대 필수 작업)**.
- **정밀도**: 실좌표는 float64, GPU는 float32. **RTC(Relative-To-Center)** — 노드/타일 중심을 double로 빼서 float32 오프셋만 업로드하고 model matrix로 배치. `Bounds.mid(nodeBounds)`가 좋은 중심. pnts 포맷은 `RTC_CENTER`를 네이티브 지원.
- `cesium.entwine.io`도 EPT를 EPSG:4978로 재투영하는 단계를 둠 → 이 경로가 검증됨.

---

## 8. 렌더링 품질 (A 채택으로 대부분 무료)

- **EDL**: `tileset.pointCloudShading = { attenuation: true, eyeDomeLighting: true, eyeDomeLightingStrength, eyeDomeLightingRadius }`. **주의: `eyeDomeLighting`은 `attenuation: true`일 때만 실제 동작.** WebGL2(Cesium 기본)에서 바로 작동.
- **포인트 크기 감쇠**: geometric-error 기반 자동. 우리는 노드 spacing → geometricError를 tileset에 정확히 매핑하면 됨. → **§8.1에서 완료(단위 버그 포함)**.
- **컬러 모드**: `Cesium3DTileStyle`로 런타임 전환. GPU 표현식이라 셰이더 작성 불필요. → **§8.2에서 구현 완료**.
- **포인트 버짓**: `maximumScreenSpaceError` + `cacheBytes`로 Potree식 버짓 근사.
- **LOD refinement**: 우리는 `refine: "ADD"` 사용 — 포인트 클라우드는 자식 노드가 부모를 대체하지 않고 **디테일을 누적**하는 구조라 COPC 옥트리 의미와 일치하고, 팝핑도 REPLACE보다 덜하다(기존 점이 사라지지 않고 점만 추가됨).

---

### 8.1 LOD 품질 튜닝 (Week 1) — 측정 로그

모두 Docker + 헤드리스(Puppeteer)로 측정. `scripts/screenshot.mjs`가 `Cesium3DTileset.statistics`를 덤프한다.
바운딩 볼륨을 바꾸면 `zoomTo()` 프레이밍이 같이 바뀌므로, A/B는 **`?cam=`으로 카메라를 고정**해야 유효하다.

#### 고친 것 1 — `geometricError` 단위 버그 (가장 큰 원인)

COPC `spacing`은 **소스 CRS 단위**인데 3D Tiles `geometricError`는 **미터** 정의다. autzen은 피트 좌표계(`spacing = 36.37`)라 GE가 **3.28배 과대**였다. Cesium은 GE를 **LOD 선택과 포인트 감쇠 크기 양쪽**에 쓰므로 오차가 두 번 나타난다.

WKT 단위를 파싱하는 대신 **재투영을 통해 직접 측정**한다(`metresPerSourceUnit`, `src/core/georef.ts`). 이렇게 하면 피트/미터뿐 아니라 **투영 스케일 왜곡**(Web Mercator는 위도에 따라 1/cos(lat)로 커짐)과 **지리좌표계(도 단위)**까지 한 번에 흡수된다.

#### 고친 것 2 — 큐브 바운딩 구 → 타이트한 oriented box

COPC 옥트리 노드 범위는 **정육면체**지만 실제 LiDAR는 얇은 판이다. `scripts/probe-copc.mjs`로 측정한 autzen: 데이터 `3426 × 4656 × 209`(소스 단위) vs 큐브 한 변 `4655` → **부피 30.25배, 반지름 1.39배 과대 포함**.

이게 두 곳에서 손해였다. ① 프러스텀 컬링이 시야 밖 타일을 못 버림, ② **SSE가 바운딩 볼륨까지의 거리로 계산**되는데 카메라가 볼륨 *안*에 들어가면 거리 0 → SSE 무한 → 최대 refine 강제. 각 노드를 **파일 실제 extent로 클램프**하고 `sphere` 대신 **oriented `box`**를 emit하도록 변경(`src/core/bounds.ts`).

#### 결과 — autzen, 동일 카메라 고정 (`sse=4`)

| 지표 | before | after | |
|---|---:|---:|---|
| 선택 포인트 | 1,291,829 | **181,525** | **7.1× ↓** |
| 선택 타일 | 44 | **6** | |
| 순회 타일(visited) | 74 | **6** | 컬링이 실제로 걸림 |
| GPU 지오메트리 | 19.4 MB | **2.7 MB** | **7.1× ↓** |
| 전체 로드 시간 | 4,116 ms | **1,341 ms** | |
| 외부 타일셋 요청 | 30 | **0** | |
| 루트 바운딩 반지름 | 1,229 m | **908 m** | |

같은 화면을 **7배 적은 포인트로** 렌더한다(스크린샷 육안 비교 시 동등). before가 과했던 것이지 after가 덜 그리는 게 아니다.

#### 고친 것 3 — 외부 타일셋 분할: 옥트리 깊이 → **타일 개수 예산**

기존 `CHUNK_LEVELS=2`는 2레벨마다 인위적 외부 타일셋 경계를 만들어, 깊이 refine할 때마다 순차 왕복이 필요했다. 그런데 **페이지 크기는 파일마다 천차만별**이다 — autzen은 전체 하이어라키가 단일 페이지 278노드, sofi는 루트 페이지 하나가 2710노드.

고정 깊이로는 양쪽을 못 맞춘다(깊이 무제한 시 sofi 루트 문서가 **1.08 MB**). 그래서 **BFS + 타일 개수 예산**(`maxTilesPerChunk`, 기본 512)으로 바꿨다. BFS라 청크가 한 갈래 깊은 가지 대신 얕은 레벨을 온전히 담는다. 예산 소진 시 큐에 남은 타일을 external tileset 참조로 **제자리 전환**한다 — 예산이 inline 타일만 세면 잘린 프론티어의 external 항목이 그대로 남아 문서가 안 줄어든다(실측: 2209항목/894 KB).

| | autzen | sofi |
|---|---:|---:|
| 루트 페이지 노드 수 | 278 | 2,710 |
| 루트 문서 (깊이 무제한) | 107 KB | 1,081 KB |
| 루트 문서 (`mt=512`) | **107 KB**(단일 문서 유지) | **208 KB** (5.2× ↓) |

#### 고친 것 4 — attenuation 배율로 구멍 메우기

GE를 정확히 고치니 `sse=8`에서 배경이 비치는 **구멍**이 생겼다. 포인트는 사각 splat인데 실제 분포는 불규칙해서, 크기를 spacing과 정확히 같게 잡으면 틈이 남는다. `pointCloudShading.geometricErrorScale`을 **1.5**로 올리면 구멍이 사라진다(`ges=1.0` 대비 스크린샷에서 확인, 포인트 수는 동일 — 렌더링만 영향).

#### `maximumScreenSpaceError` 스윕 (autzen, 근접 카메라 511 m)

| sse | 선택 포인트 | 타일 | GPU | 로드 | 화질 |
|---:|---:|---:|---:|---:|---|
| 2 | 4,142,444 | 101 | 62.1 MB | 9,534 ms | 과잉 |
| **4** | **1,178,906** | **33** | **17.7 MB** | **3,097 ms** | **기본값** |
| 8 | 494,215 | 13 | 7.4 MB | 1,747 ms | `ges=1.5`면 연속, 약간 소프트 |
| 16 | 230,562 | 6 | 3.5 MB | 1,543 ms | 지나치게 성김 |

#### 확정 기본값

| 값 | 기본 | 쿼리 | 근거 |
|---|---:|---|---|
| `maximumScreenSpaceError` | 4 | `?sse=` | 위 스윕. Cesium 기본 16은 포인트 클라우드엔 과하게 성김 |
| `geometricErrorScale` | 1.5 | `?ges=` | 1.0은 구멍 발생, 2.0은 뭉개짐 |
| `maximumAttenuation` | 8 px | `?maxatt=` | 근접 시 블롭화 방지 |
| `cacheBytes` / overflow | 512 MB | `?cache=` | 임의 크기 파일에서 메모리 상한 |
| `maxTilesPerChunk` | 512 | `?mt=` | 위 표 |
| `dynamicScreenSpaceError` | **off** | `?dyn=1` | autzen의 사선·수평선 뷰 **양쪽에서 측정상 무변화**라 켤 근거 없음(Cesium 기본도 false). 뷰보다 훨씬 큰 데이터셋에서만 의미 |

#### 대용량 회귀 검증 — sofi (2.03 GB, 364M pts, sub-page 111개)

근접 카메라(`?zoom=0.05`)에서 **실제 COPC sub-page 21개**를 lazy 로드(외부 타일셋 22, pnts 143, 2.95M 포인트, 35.4 MB). 2 GB 파일을 range 스트리밍하며 동작. RGB가 없어 회색+EDL로 표시되고, 수면은 LiDAR 반사가 없어 비는 것이 정상.

예산 경계에서 잘린 노드 중 **자식이 없는 리프는 전환하지 않는다** — 이미 갖고 있는 타일 하나를 받으려 왕복을 쓰기 때문. 이 처리로 sofi 외부 타일셋 요청이 28 → **22**로 줄었고 출력은 동일했다.

> 주의: 개요 카메라에서는 refine이 루트 청크(513타일) 안에서 끝나 `page.json` 요청이 0이다. 이는 lazy 로딩이 의도대로 동작하는 것이지 회귀가 아니다 — sub-page 경로 검증은 반드시 근접 카메라로 해야 한다.

---

### 8.2 컬러 모드 (rgb / elevation / intensity / classification)

`pnts`는 POSITION+RGB만 싣고 있었다. 스타일링에 필요한 per-point 값을 **Batch Table**로 추가한다 — `pnts`에서 feature table에 `BATCH_ID`가 없으면 batch table은 **포인트 단위로 인덱싱**되며, 이게 정확히 Cesium 스타일 언어의 `${Intensity}` 등이 읽는 형태다.

**고도 램프에 `${POSITION}[2]`를 쓰면 안 된다.** 스타일 언어의 `${POSITION}`은 **타일 로컬 좌표**인데 우리는 타일마다 노드 centroid를 `RTC_CENTER`로 잡는다 → 램프가 타일 경계마다 리셋된다. 그래서 소스 Z에 수직 단위 계수를 적용한 **절대 높이(m)를 `Height` 속성으로 명시 인코딩**한다. 실제 렌더에서 타일 경계를 넘어 연속적인 그라디언트가 나오는 것으로 확인됨.

**범위는 클라이언트가 알 수 없다.** 램프에는 min/max가 필요한데 이 정보는 SW에만 있다. 생성한 `tileset.json`의 `asset.extras`에 실어 보낸다(Cesium이 `tileset.asset`에 그대로 보존). 높이 범위는 COPC 헤더 + 수직 단위 계수로 즉시 나오지만, **LAS에는 intensity 범위 필드가 없어** 루트 노드에서 실측한다(어차피 모든 뷰어가 로드하는 노드). 고정 `[0, 65535]`를 쓰면 대부분의 데이터가 거의 검게 나온다.

**기본 모드 선택의 순환 문제**: 기본값은 파일의 RGB 유무에 달렸는데, attribute 집합은 타일셋 URL에 인코딩되므로 URL을 만들기 *전에* 정해져야 한다. 헤더만 읽는 `info.json` 엔드포인트를 추가해 해결했다. `colorMode`를 명시하면 이 요청은 생략된다.

#### 비용과 전환

| | |
|---|---|
| 바이트/포인트 | position+color 15, `height` +4, `intensity` +2, `classification` +1 |
| autzen 동일 카메라 GPU 지오메트리 | 17.7 MB → **25.9 MB** (전 속성, +47%) |
| 모드 전환 시 재요청 타일 | **0** (`scripts/smoke-colormode.mjs`로 검증) |

전환이 공짜인 이유는 스타일이 GPU 표현식이기 때문이다. 대신 **해당 속성이 타일에 실려 있어야** 하므로, 나중에 쓸 모드는 `attributes`로 미리 요청해야 한다. 없는 속성의 모드로 바꾸면 조용히 잘못 그리는 대신 throw 한다.

검증: autzen 4개 모드 전부 렌더 확인. sofi(RGB 없음)는 `hasColor: false` → **`elevation` 자동 선택**되고 sub-page lazy 경로(distinct page 21개)도 그대로 동작.

### 8.3 디코드 워커 풀 (Week 2) — 측정 로그

SW가 **단일 스레드**로 laz-perf 디코드를 돌리는 것이 리스크 표의 유일한 미해결 항목이었다. 워커 풀로 옮겼고, **동시에 그게 실제 병목이 아니었다는 것도 측정으로 확인**했다. 두 결과 모두 아래에 남긴다.

#### 제약 — Service Worker는 워커를 만들 수 없다

HTML 스펙의 IDL이 `[Exposed=(Window,DedicatedWorker,SharedWorker)]`이라 **`ServiceWorkerGlobalScope`에는 `Worker`가 노출되지 않는다**. Chrome 150 헤드리스 실측에서도 `typeof Worker === 'undefined'`, `new Worker()` → `ReferenceError`(classic·module 양쪽). 브라우저 버그가 아니라 설계이므로 우회 불가.

**그래서 페이지가 워커를 만들고 `MessagePort`를 SW로 transfer 한다.** 이후 SW ↔ 워커가 직결되어 페이지 메인 스레드를 거치지 않는다. 대안(SW → 페이지 `message` 핸들러 → 워커)과 4 MB 버퍼 왕복으로 비교:

| 경로 | 유휴 | **메인 스레드 1 s 블록 중** |
|---|---:|---:|
| SW → 페이지 → 워커 | 11.2 ms | **1001.7 ms** |
| SW → 워커 직결 (채택) | 2.9 ms | **0.2 ms** |

Cesium은 렌더 루프가 메인 스레드를 점유하므로 이 차이가 결정적이다. 버퍼는 transferable이라 복사도 없다.

#### 생명주기 — 유일한 실패 모드

포트는 직렬화가 불가능한데 **브라우저는 유휴 SW를 언제든 정지**시킨다. 되살아난 SW는 포트가 없다. 그래서: 포트가 없는 상태로 타일 요청이 오면 ① 그 타일은 인라인 디코드로 즉시 응답하고 ② 클라이언트들에 `need-ports`를 브로드캐스트해 재핸드셰이크한다. `scripts/smoke-pool.mjs`가 CDP로 SW를 실제로 정지시켜 이 경로를 검증한다 — 재시작 직후 첫 타일 인라인 143 ms → 재핸드셰이크 → 다음 타일 풀 59.6 ms, fallback 0건.

#### 결과 — 디코드는 3.4배 빨라졌지만, 병목이 아니었다

autzen 근접 고정 카메라, `sse=1`(214 타일, 8.88M pts). `swDecode`는 SW가 잰 타일당 디코드 응답 지연의 합.

| | workers=0 | workers=6 |
|---|---:|---:|
| 타일당 디코드 지연 | 696 ms | **204 ms** (3.4× ↓) |
| 전체 `loadMs` | 24.7 s | **21.4 s** (13% ↓) |
| `pointsSelected` | 8,884,987 | 8,884,987 (동일) |

`sse=4`(33 타일)에서는 4.18 s → 3.08 s (26% ↓).

디코드 지연이 3.4배 줄었는데 전체는 13%만 줄었다 → **남는 시간은 Cesium이 메인 스레드에서 `pnts`를 Model로 트랜스코드하고 GPU에 올리는 비용**이다(214 타일 × ~100 ms). 헤드리스는 swiftshader(소프트웨어 GL)라 이 몫이 실제 GPU보다 과대평가된다. 즉 실환경 개선폭은 13%보다 크되, **디코드가 지배적이라는 원래 가정은 틀렸다.**

#### sofi(2 GB 원격)는 100% 대역폭 병목

| | loadMs | 타일당 디코드 지연 |
|---|---:|---:|
| workers=0 | 146.9 s | 7,288 ms |
| workers=6 | 145.0 s | 7,373 ms |

풀 유무와 무관하게 타일당 7.3초 — 전부 I/O 대기다. Cesium 요청 동시성을 올려도(`RequestScheduler.maximumRequestsPerServer` 6 → 24 → 48) 147 s / 136 s로 변화가 없고 **지연 합만 커진다**(대역폭 포화의 전형). 실제 파이프를 재보면 50 MB range 기준 **vite 프록시 경유 3.98 MB/s, S3 직결 6.31 MB/s** — sofi 근접 뷰가 받는 바이트를 이 속도로 나누면 측정된 ~140 s가 그대로 나온다.

> **핸드오프에 적혀 있던 "sofi 근접 로드 ~80 s = laz-perf 디코드 성능"은 오귀인이었다.** 그 수치는 네트워크였다. 워커 풀은 여전히 옳은 구조지만(SW 단일 스레드 직렬화 제거, 대역폭이 넉넉한 로컬·사내 데이터에서 이득이 그대로 남음), **대용량 원격 파일의 로드 시간을 줄이는 수단은 아니다.**

`?workers=`(개수)와 `?maxreq=`(Cesium 요청 상한)로 데모에서 A/B 할 수 있다.

---

## 9. 리스크 & 완화

| 리스크 | 심각도 | 완화 |
|--------|:-----:|------|
| **SW 콘텐츠 브리지가 예상보다 복잡** | 高 | **Week 0 PoC에서 이 경로를 최우선 검증**. 안 되면 방식 1(blob)로 데모 확보 후 SW 병행 |
| Implicit tiling subtree 생성 난이도 | 中 | 초기엔 explicit nested tileset로 시작, implicit는 최적화 단계로 |
| CRS→ECEF 재투영·정밀도 버그 | 中 | 알려진 CRS(UTM/3857)부터, RTC 철저 적용, 소용량으로 시각 검증 |
| ~~laz-perf 디코드 성능~~ | ~~中~~ → **해소** | 워커 풀 도입(§8.3). 측정 결과 애초에 병목이 아니었음 — 남는 병목은 Cesium 메인 스레드 트랜스코드와 네트워크 대역폭이며 둘 다 우리 코드 밖 |
| copc/laz-perf 0.0.x 프리릴리스 | 低 | 버전 핀, 필요시 fork |
| Cesium private API 회피 | — | A 채택으로 대부분 회피(공개 API 사용) |

---

## 10. PoC 계획 (Week 0 연동)

**목표: A+SW 콘텐츠 브리지의 make-or-break를 조기 검증**

1. **[간이] blob 경로**: 루트+1~2레벨 노드를 선디코드 → explicit tileset.json + blob content → Cesium에 표시. *"copc.js로 읽은 점이 Cesium에 뜬다" 최소 검증.*
2. **[본선] SW 경로**: SW가 단일 노드 `.pnts` 요청을 가로채 copc.js→디코드→pnts 인코딩→응답. Cesium3DTileset이 그걸 소비하는지 확인. *채택 아키텍처의 핵심 리스크 제거.*
3. CRS→ECEF 재투영 + RTC로 실제 지형 위에 정확히 안착하는지 시각 확인.

이 세 가지가 통과하면 아키텍처 확정, Week 1(스트리밍 LOD)로 진행.

---

## 11. 차별화 요약 (경쟁 포지셔닝)

- **on-the-fly COPC→3D Tiles in CesiumJS는 Eptium(클로즈드) 단 하나** → 우리는 **첫 오픈소스 라이브러리**.
- 모든 OSS COPC 웹 렌더러(Potree/Giro3D/iTowns)는 **three.js** 기반 → **Cesium 생태계(ion 지형, 3D Tiles 건물, imagery)와 겹쳐보기**는 우리만의 이점.
- 기존 Cesium 경로(cesium.entwine.io, py3dtiles)는 **오프라인 사전 변환 필요** → 우리는 서버 스텝 제거.

### 근거: COPC 공식 소프트웨어 레지스트리 (copc.io/software.html)

과제가 참고자료로 지목한 **COPC 공식 지원 소프트웨어 목록**(https://copc.io/software.html, 2026-07 조사)을 전수 확인한 결과:

| 분류 | 등록된 도구 |
|------|-------------|
| **웹 브라우저 시각화** | **iTowns, Giro3D — 둘 다 three.js 기반, 둘 다 copc.js 사용** |
| 읽기/쓰기 라이브러리 | copc.js(JS/TS), PDAL(C++), COPC-lib(C++/Py), laspy(Py), copc-rs·copc-converter·copc-streaming(Rust/wasm), copc4R(R) |
| 변환/CLI | Untwine, LAStools, OpenDroneMap |
| 데스크톱 뷰어/GIS | QGIS 3.26, QT Modeler, FUSION, Manifold, Agisoft |
| ETL/검증 | Safe FME, Kart, copc-validator.js |

> **핵심 근거: 공식 레지스트리에 CesiumJS 기반 COPC 시각화 도구는 0개.** 웹 렌더러는 iTowns·Giro3D 둘뿐이며 모두 three.js. (Eptium은 클로즈드·미등록.) → *"첫 OSS Cesium-native COPC 뷰어"* 차별화가 권위 있는 출처로 입증된다. 또한 두 웹 렌더러 모두 **copc.js를 리더로 채택** → 우리의 copc.js 선택도 업계 정석임을 재확인.

---

## 부록 A — 주요 참고자료

- COPC 스펙: https://copc.io/ · copc.js: https://github.com/connormanning/copc.js (MIT)
- Cesium `PointCloudShading`: https://cesium.com/learn/cesiumjs/ref-doc/PointCloudShading.html
- EDL+감쇠 PR #6069: https://github.com/CesiumGS/cesium/pull/6069
- 3D Tiles Implicit Tiling: https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc
- 런타임 tileset 로딩(blob/data URI): https://community.cesium.com/t/loading-3dtile-from-tileset-json-string-json-object-instead-of-url/21637
- Eptium(선행·클로즈드): https://cesium.com/blog/2025/06/20/hobu-eptium-point-clouds-cesiumjs/ · https://viewer.copc.io/
- cesium.entwine.io(오프라인 EPT→3D Tiles, Apache-2.0): https://github.com/connormanning/cesium.entwine.io
- TIFFImageryProvider(패키징 템플릿, MIT): https://github.com/hongfaqiu/TIFFImageryProvider
- Giro3D COPC(OSS 렌더 로직 참고, three.js): https://giro3d.org/next/examples/copc.html
