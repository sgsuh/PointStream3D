# SBOM — 소프트웨어 자재명세서

PointStream3D · KOSSA 2026 오픈소스 개발자대회 결과보고서 **붙임1** 초안.

- 기준일: 2026-08-07 · 커밋 `52dd49e`
- 기재 순서는 대회 서식의 우선순위 기준(① GPL·AGPL·LGPL 계열 → ② 핵심 기능 → ③ 주요 프레임워크·SDK → ④ 빌드·실행 도구)을 따른다. **최대 10개**.
- 버전은 `node_modules`에 실제로 설치된 것(`package.json`의 semver 범위가 아니라 확정 버전).

> **① GPL·AGPL·LGPL 계열: 해당 없음.** 설치된 87개 패키지 전수 조사 결과 카피레프트 계열은 `dompurify`(CesiumJS 전이 의존성) 하나뿐이고, 그마저 `MPL-2.0 OR Apache-2.0` 듀얼 라이선스라 **Apache-2.0을 선택**하면 된다. 따라서 표는 ②부터 시작한다.

## 붙임1 표

| 번호 | 라이브러리명 | 버전 | 라이선스 | 공식 저장소 URL | 사용 목적 및 주요 기능 |
|:--:|---|---|---|---|---|
| 1 | copc.js | 0.0.8 | MIT | github.com/connormanning/copc.js | COPC 파일 파싱 — 헤더·VLR·옥트리 계층 페이지 읽기, 노드 단위 포인트 뷰 생성 / 라이브러리로 불러 씀 (배포 산출물에 번들) |
| 2 | LAZperf | 0.0.7 | Apache-2.0 | github.com/hobuinc/laz-perf | LAZ 압축 해제 (WebAssembly) — 옥트리 노드 청크를 브라우저에서 디코드 / 라이브러리로 불러 씀 + `laz-perf.wasm` 바이너리 동봉 배포 |
| 3 | Proj4js | 2.20.9 | MIT | github.com/proj4js/proj4js | 좌표계 재투영 — 소스 CRS→WGS84 변환, 복합 CRS(`COMPD_CS`) 처리 / 라이브러리로 불러 씀 (배포 산출물에 번들) |
| 4 | CesiumJS | 1.143.0 | Apache-2.0 | github.com/CesiumGS/cesium | 3D 지구 렌더링 엔진 — 생성한 3D Tiles를 소비하며 LOD·프러스텀 컬링·요청 스케줄링·EDL 담당 / **peerDependency, 번들하지 않음** |
| 5 | wkt-parser | 1.5.6 | MIT | github.com/proj4js/wkt-parser | WKT CRS 문자열 파싱 (Proj4js 전이 의존성) / 배포 산출물에 번들 |
| 6 | mgrs | 1.0.0 | MIT | github.com/proj4js/mgrs | MGRS 좌표 변환 (Proj4js 전이 의존성) / 배포 산출물에 번들 |
| 7 | cross-fetch | 3.2.0 | MIT | github.com/lquixada/cross-fetch | fetch 폴리필 (copc.js 전이 의존성). 자체 HTTP-range Getter를 주입해 실사용 경로에서는 우회하나 번들에는 포함 |
| 8 | TypeScript | 5.9.3 | Apache-2.0 | github.com/microsoft/TypeScript | 전체 소스 작성 언어 및 타입 검사, 배포용 `.d.ts` 생성 / 빌드 도구 |
| 9 | Vite | 5.4.21 | MIT | github.com/vitejs/vite | 개발 서버 및 라이브러리·데모 번들링 / 빌드 도구 |
| 10 | esbuild | 0.21.5 | MIT | github.com/evanw/esbuild | Service Worker·디코드 워커를 단일 ESM으로 번들 / 빌드 도구 |

## 근거 및 확인 방법

**전수 조사** — `node_modules` 87개 패키지의 `package.json` 라이선스 필드를 전부 읽어 집계:

| 라이선스 | 개수 |
|---|---:|
| MIT | 61 |
| Apache-2.0 | 10 |
| ISC | 9 |
| BSD-3-Clause | 3 |
| MPL-2.0 OR Apache-2.0 | 1 (`dompurify`) |
| MIT AND Zlib | 1 |
| 0BSD | 1 |
| BSD-2-Clause | 1 |

**LAZperf는 별도 확인이 필요했다.** npm 패키지에 LICENSE 파일도 `repository` 필드도 없고 `license: "Apache-2.0"`만 선언돼 있다. LAZ 포맷 구현체 중 원조 격인 LASzip이 LGPL이라 오염 가능성을 의심할 만한데, 상류 저장소(github.com/hobuinc/laz-perf)에서 **Apache-2.0**임을 직접 확인했다. LASzip 코드를 가져온 것이 아니라 Hobu의 독립 구현이다.

**배포 산출물에 실제로 들어가는 패키지**는 esbuild metafile로 확인했다. `pointstream3d-sw.js`와 `pointstream3d-worker.js` 양쪽 모두 동일하게 아래 6개만 포함한다 — 표의 1·2·3·5·6·7번이 여기 해당하며, 이들만이 **재배포 의무**의 대상이다.

| 패키지 | 번들 기여 |
|---|---:|
| proj4 | 242.9 kB |
| laz-perf | 85.7 kB |
| copc | 51.7 kB |
| wkt-parser | 35.0 kB |
| mgrs | 20.5 kB |
| cross-fetch | 20.4 kB |

CesiumJS는 peerDependency로 external 처리되어 번들에 포함되지 않는다(클라이언트 진입점이 9 kB인 이유).

## 정리

- **우리 코드의 라이선스: MIT** (OSI 인증) — 서식의 "직접 작성한 코드의 오픈소스 라이선스" 항목에 그대로 기재 가능.
- 번들되는 6개 패키지가 전부 MIT / Apache-2.0 **퍼미시브**라 MIT 배포와 충돌 없음.
- **고지 의무 이행 완료.** Apache-2.0 §4(a)는 수령자에게 라이선스 사본을 제공할 것을 요구한다. `npm run build`가 `dist/THIRD-PARTY-NOTICES.txt`를 생성하며(데모 사이트에도 동일 파일이 들어간다), `files: ["dist", ...]`에 이미 포함되므로 npm 배포물에 자동으로 실린다.

## 고지 파일 생성 방식

`scripts/notices.mjs`가 만들고 `scripts/build-sw.mjs`가 번들을 만들 때 함께 호출한다. 목록은 **package.json이 아니라 esbuild metafile에서** 뽑는다 — 실제로 산출물에 들어간 것만이 재배포 대상이고, 그래야 의존성이 새로 추가돼도 고지 없이 배포되는 일이 구조적으로 불가능하다.

- 각 패키지의 `LICENSE`/`COPYING`/`NOTICE` 파일을 원문 그대로 싣는다.
- 라이선스 파일이 없는 패키지(**LAZperf가 유일**)는 선언된 SPDX 식별자에 해당하는 정본을 `scripts/licenses/<id>.txt`에서 가져오고, 출처가 정본임을 고지문에 명시한다.
- 둘 다 없으면 **빌드를 실패시킨다.** 조용히 누락되는 것보다 낫다 (`bitmap-sdf`로 실패 경로 확인 완료).
