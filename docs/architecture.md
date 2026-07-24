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

```
packages/pointstream3d/
├─ src/
│  ├─ index.ts                  # 공개 API: COPCPointCloud.fromUrl()
│  ├─ core/
│  │  ├─ CopcSource.ts          # copc.js 래핑: Getter(캐시/헤더/인증), 헤더·info·계층
│  │  ├─ Hierarchy.ts           # 옥트리 계층 lazy 순회, VoxelKey↔bounds (Bounds.stepTo)
│  │  └─ Reproject.ts           # copc.wkt → proj4 → ECEF, RTC(상대좌표) 처리
│  ├─ tiles/
│  │  ├─ ImplicitTileset.ts     # 가상 tileset.json + subtree availability 생성
│  │  ├─ PntsEncoder.ts         # 디코드된 타입배열 → pnts (1차) / glTF POINTS (2차)
│  │  └─ nodeToTile.ts          # COPC 노드 → 3D Tile 콘텐츠
│  ├─ worker/
│  │  ├─ sw.ts                  # Service Worker: fetch 가로채기 + 트랜스코드
│  │  └─ decodePool.ts          # laz-perf 디코드 워커 풀(SW 내부 or 별도)
│  ├─ render/
│  │  ├─ CesiumRenderer.ts      # Cesium3DTileset 생성·부착, pointCloudShading/style 설정
│  │  └─ Renderer.ts            # 렌더러 인터페이스(추상화) — A/B 교체 지점
│  └─ options.ts                # 중첩 옵션(colorMode/pointBudget/edl/sse/requestOptions)
├─ vite-example/                # 라이브 데모 (GitHub Pages)
└─ package.json                 # peerDependencies: { cesium }, dep: copc, laz-perf, proj4
```

### 공개 API (TIFFImageryProvider 미러링)

```ts
const pc = await COPCPointCloud.fromUrl(url, {
  requestOptions: { headers, credentials, maxRanges },
  colorMode: 'rgb' | 'classification' | 'intensity' | 'elevation',
  pointBudget: 3_000_000,
  screenSpaceError: 16,
  pointCloudShading: { attenuation: true, eyeDomeLighting: true, edlStrength: 1.0 },
});
viewer.scene.primitives.add(pc);   // 포인트는 imagery가 아니므로 primitives/tileset로 부착
viewer.flyTo(pc);
```

- **`static fromUrl()`** 비동기 팩토리 (Cesium 1.104+ 관례, TIFFImageryProvider와 동일)
- **`cesium`은 peerDependency** — 절대 번들하지 않음
- 내부적으로 `CesiumRenderer`가 `Cesium3DTileset.fromUrl(가상 tileset URL)`을 만들고 `pointCloudShading`·`Cesium3DTileStyle`을 설정

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
- **포인트 크기 감쇠**: geometric-error 기반 자동. 우리는 노드 spacing → geometricError를 tileset에 정확히 매핑하면 됨.
- **컬러 모드**: `Cesium3DTileStyle`로 런타임 전환 — RGB / `${Intensity}` / `${Classification}` / `${POSITION}[2]`(고도 램프). GPU 표현식이라 셰이더 작성 불필요.
- **포인트 버짓**: `maximumScreenSpaceError` + `cacheBytes`로 Potree식 버짓 근사.
- **LOD 팝핑 완화**: SSE 기반 크기 전환 + Cesium의 타일 페이드. (pnts는 replacement refinement가 기본이고 EDL도 여기서 최적.)

---

## 9. 리스크 & 완화

| 리스크 | 심각도 | 완화 |
|--------|:-----:|------|
| **SW 콘텐츠 브리지가 예상보다 복잡** | 高 | **Week 0 PoC에서 이 경로를 최우선 검증**. 안 되면 방식 1(blob)로 데모 확보 후 SW 병행 |
| Implicit tiling subtree 생성 난이도 | 中 | 초기엔 explicit nested tileset로 시작, implicit는 최적화 단계로 |
| CRS→ECEF 재투영·정밀도 버그 | 中 | 알려진 CRS(UTM/3857)부터, RTC 철저 적용, 소용량으로 시각 검증 |
| laz-perf 디코드 성능 | 中 | 워커 풀, 노드 캐시, pointBudget 상한 |
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
