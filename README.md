# 서울 트윈

서울을 회전, 확대, 기울여 볼 수 있는 3D 디지털 트윈입니다. 빌드 과정과 API 키 없이 정적 파일만으로 동작하며 GitHub Pages 에서 서비스합니다.

- 기본 모드: https://jihongparker.github.io/seoul-twin/
- 정밀 모드: https://jihongparker.github.io/seoul-twin/tiles.html

![서울 트윈 대표 이미지](img/hero.webp)

## 두 가지 모드

| | 기본 모드 (`index.html`) | 정밀 모드 (`tiles.html`) |
|---|---|---|
| 엔진 | MapLibre GL JS 5 | CesiumJS 1.145 |
| 건물 | OpenFreeMap 벡터 타일의 OpenStreetMap 높이를 압출 | Re:Earth Buildings 3D Tiles (Overture Maps, OpenStreetMap 외곽선) |
| 지형 | AWS Terrain Tiles (Terrarium) | Re:Earth Terrain 양자화 메시 (Mapterhorn) |
| 바탕 | OpenFreeMap liberty, fiord(밤) | OpenStreetMap 표준 래스터 |
| 층 | 자치구 25곳, 지하철 10개 노선과 역 338곳, 랜드마크 16곳 | 같은 자치구·지하철·랜드마크 자료를 지형 위에 붙임 |
| 특징 | 높이 필터, 시각별 조명과 낮·밤 전환, 자치구 정보 패널, Grok 질의 | 건물 메시가 촘촘하고 지형이 정확함 |

두 모드는 같은 시점(URL 해시)을 주고받습니다. 기본 모드에서 보던 자리 그대로 정밀 모드로 넘어가고 돌아올 수 있습니다.

## 조작

- 드래그로 이동, 휠로 확대, 우클릭 드래그 또는 Ctrl 드래그로 회전, Shift 와 화살표로 기울기
- 상단 버튼: 북쪽 맞춤(N), 자동 회전(R), 랜드마크 투어(T), 화면 저장, 시점 링크 복사, 정밀 모드
- 검색창에 자치구, 랜드마크, 역 이름을 넣으면 해당 위치로 날아갑니다
- 자치구를 클릭하면 면적, 지하철역 수, 설명이 오른쪽 패널에 나옵니다
- 시각 슬라이더를 움직이면 조명 방향이 바뀌고 19시 이후와 6시 이전은 밤 스타일로 전환됩니다

## Grok 질의

왼쪽 패널 아래에 xAI API 키를 넣으면 현재 화면 좌표와 선택한 자치구를 문맥으로 `grok-4.6` 이 웹 검색과 함께 답합니다. 키는 브라우저 localStorage 에만 저장되며 서버로 보내지 않습니다. api.x.ai 가 CORS 를 허용하므로 별도 프록시가 필요 없습니다.

제작 과정에서도 grok API 를 썼습니다. 자치구 25곳과 랜드마크 16곳의 설명문 초안은 `grok-4.6` 이 한 번의 호출로 쓰고 사람이 사실을 확인해 `data/grok_notes.json` 에 넣었습니다. 대표 이미지는 `grok-imagine-image-2.0` 이 생성했습니다.

## 데이터

| 파일 | 출처 | 만드는 방법 |
|---|---|---|
| `data/seoul_gu.geojson` | 통계청 행정구역 경계 (southkorea/seoul-maps) | `tools/build_data.py` 가 면적과 역 수, 중심점을 계산해 붙임 |
| `data/subway_lines.geojson` | OpenStreetMap `route=subway` 관계 152개 | 노선(ref)별로 병합, 색은 OSM `colour` 태그 |
| `data/subway_stations.geojson` | OpenStreetMap `railway=station` 노드 | 이름과 좌표로 중복 제거 |
| `data/landmarks.json` | OpenStreetMap 요소 16개 | id 로 지정, 높이와 층수는 OSM 태그 |
| `data/grok_notes.json` | grok-4.6 초안, 검수본 | 수동 |

원본 Overpass 응답은 `tools/raw/` 에 두며 저장소에는 넣지 않습니다. 다시 만들려면 Overpass 로 원본을 받은 뒤 `python3 tools/build_data.py` 를 실행합니다.

## 왜 이 구성인가

- Cesium ion, Google Photorealistic 3D Tiles, Mapbox, V-World 는 모두 키가 필요합니다. 이 저장소는 공개 정적 호스팅이 목표라 키가 없는 자료만 골랐습니다.
- MapLibre 6 은 ESM 전용 배포라 cdnjs 에 UMD 번들이 없습니다. 스크립트 태그 한 줄로 끝내기 위해 5.24 를 씁니다.
- deck.gl 의 Tile3DLayer 로 Re:Earth 3D Tiles 를 올리는 방법은 시험했으나 전 지구 region 경계 볼륨을 가진 외부 tileset 트리를 순회하지 못해 타일이 선택되지 않았습니다. CesiumJS 는 같은 tileset 을 문제없이 그려서 정밀 모드는 CesiumJS 로 분리했습니다.
- 정밀 모드의 바탕 이미지는 OpenStreetMap 표준 타일입니다. CARTO 래스터는 2026년 현재 키 없이는 워터마크가 찍혀 쓸 수 없었습니다. 트래픽이 커지면 키 있는 래스터로 바꿔야 합니다.

## 저작권 표시

OpenFreeMap, OpenMapTiles, OpenStreetMap contributors (ODbL), Overture Maps Foundation, Re:Earth Buildings and Terrain, Mapterhorn (CC BY 4.0), AWS Terrain Tiles (Mapzen), CesiumJS (Apache 2.0), MapLibre GL JS (BSD 3-Clause). 각 화면의 저작권 표시줄에 같은 내용이 나옵니다.
