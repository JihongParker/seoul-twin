#!/usr/bin/env python3
"""
build_data.py -- Seoul Twin 데이터 빌드 스크립트

입력 (tools/raw/, Overpass/공공데이터 원본 캐시):
  - seoul_gu.json        : 서울 25개 자치구 GeoJSON (Polygon/MultiPolygon, WGS84)
  - subway_full.json     : Overpass 결과. relation(노선, route=subway)과
                            way(선형 지오메트리)를 포함
  - subway_stations.json : Overpass 결과. node(railway=station)만 사용
  - landmarks.json        : Overpass 결과. node/way/relation, 이름 중복 다수

출력 (data/, 압축 JSON, 좌표 소수 5자리 반올림):
  - seoul_gu.geojson        : 25개 구 폴리곤 + {code,name,name_eng,area_km2,
                               stations,centroid}
  - subway_lines.geojson    : 노선별 MultiLineString + {line,name,colour,ways}
  - subway_stations.geojson : 역 Point + {name,name_en,network} (이름/좌표 중복 제거)
  - landmarks.json           : 랜드마크 16곳 좌표/속성 배열

실행: 저장소 루트에서 `python3 tools/build_data.py`
      (경로는 이 스크립트 파일 위치 기준 상대 경로로 해석 -> 어디서 실행해도 동일한 결과, 멱등적)
"""

import json
import math
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = BASE_DIR / "tools" / "raw"
DATA_DIR = BASE_DIR / "data"

EARTH_RADIUS_KM = 6371.0088


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def r5(v):
    """좌표 소수 5자리 반올림"""
    return round(v, 5)


# ---------------------------------------------------------------------------
# 1. seoul_gu.geojson
# ---------------------------------------------------------------------------

def flatten_rings(geometry):
    """Polygon/MultiPolygon geometry -> ring(좌표 리스트)들의 평탄한 리스트"""
    if geometry["type"] == "Polygon":
        return list(geometry["coordinates"])
    elif geometry["type"] == "MultiPolygon":
        rings = []
        for poly in geometry["coordinates"]:
            rings.extend(poly)
        return rings
    return []


def ring_signed_area_and_moment(ring_xy):
    """투영된 (x,y) 평면좌표 ring 의 signed area 와 1차 모멘트(centroid*area) 반환"""
    n = len(ring_xy)
    if n < 3:
        return 0.0, 0.0, 0.0
    a = 0.0
    mx = 0.0
    my = 0.0
    for i in range(n - 1):
        x0, y0 = ring_xy[i]
        x1, y1 = ring_xy[i + 1]
        cross = x0 * y1 - x1 * y0
        a += cross
        mx += (x0 + x1) * cross
        my += (y0 + y1) * cross
    # ring 이 닫혀있지 않으면 마지막 점 -> 첫 점 구간도 더해준다
    x0, y0 = ring_xy[-1]
    x1, y1 = ring_xy[0]
    if (x0, y0) != (x1, y1):
        cross = x0 * y1 - x1 * y0
        a += cross
        mx += (x0 + x1) * cross
        my += (y0 + y1) * cross
    a *= 0.5
    return a, mx, my


def area_km2_and_centroid(geometry):
    """구면(적도-원통) 근사 투영 후 area(km2) 와 area-weighted centroid(lon,lat) 계산.
    Polygon/MultiPolygon 의 모든 ring(외곽+홀)에 대해 signed area 를 누적하면
    홀은 자연히 반대 부호로 상쇄된다."""
    rings = flatten_rings(geometry)
    if not rings:
        return 0.0, (0.0, 0.0)

    all_lats = [pt[1] for ring in rings for pt in ring]
    lat_ref = math.radians(sum(all_lats) / len(all_lats))
    cos_ref = math.cos(lat_ref)

    def project(lon, lat):
        x = math.radians(lon) * EARTH_RADIUS_KM * cos_ref
        y = math.radians(lat) * EARTH_RADIUS_KM
        return x, y

    total_a = 0.0
    total_mx = 0.0
    total_my = 0.0
    for ring in rings:
        ring_xy = [project(pt[0], pt[1]) for pt in ring]
        a, mx, my = ring_signed_area_and_moment(ring_xy)
        total_a += a
        total_mx += mx
        total_my += my

    area_km2 = abs(total_a)
    if total_a == 0:
        cx, cy = project(all_lats and rings[0][0][0] or 0, sum(all_lats) / len(all_lats))
        lon_c, lat_c = rings[0][0][0], sum(all_lats) / len(all_lats)
        return area_km2, (lon_c, lat_c)

    cx = total_mx / (6 * total_a)
    cy = total_my / (6 * total_a)

    # 역투영
    lon_c = math.degrees(cx / (EARTH_RADIUS_KM * cos_ref))
    lat_c = math.degrees(cy / EARTH_RADIUS_KM)
    return area_km2, (lon_c, lat_c)


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            x_int = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_int:
                inside = not inside
        j = i
    return inside


def point_in_geometry(lon, lat, geometry):
    """모든 ring(외곽+홀)에 대해 XOR 방식 ray-casting. MultiPolygon 은 폴리곤 간 OR."""
    if geometry["type"] == "Polygon":
        polys = [geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        polys = geometry["coordinates"]
    else:
        return False

    for poly in polys:
        inside = False
        for ring in poly:
            if point_in_ring(lon, lat, ring):
                inside = not inside
        if inside:
            return True
    return False


def build_seoul_gu(station_points):
    raw = load_json(RAW_DIR / "seoul_gu.json")
    features = []
    for feat in raw["features"]:
        props = feat["properties"]
        geom = feat["geometry"]
        area_km2, (lon_c, lat_c) = area_km2_and_centroid(geom)
        count = sum(1 for lon, lat in station_points if point_in_geometry(lon, lat, geom))
        new_props = {
            "code": props.get("code"),
            "name": props.get("name"),
            "name_eng": props.get("name_eng"),
            "area_km2": round(area_km2, 1),
            "stations": count,
            "centroid": [r5(lon_c), r5(lat_c)],
        }
        new_geom = {
            "type": geom["type"],
            "coordinates": round_coords(geom["coordinates"]),
        }
        features.append(
            {"type": "Feature", "properties": new_props, "geometry": new_geom}
        )
    return {"type": "FeatureCollection", "features": features}


def round_coords(coords):
    """중첩 좌표 배열을 재귀적으로 소수 5자리 반올림"""
    if isinstance(coords[0], (int, float)):
        return [r5(coords[0]), r5(coords[1])]
    return [round_coords(c) for c in coords]


# ---------------------------------------------------------------------------
# 2. subway_lines.geojson
# ---------------------------------------------------------------------------

NAME_SUFFIX_RE = re.compile(r"\s*[:：].*$")

# 데이터에 ref 태그가 없을 때 노선명에서 키를 추정하기 위한 후보 목록
NAME_KEY_CANDIDATES = [
    "경의중앙", "공항", "수인분당", "우이신설", "경춘",
    "서해", "김포골드", "신림", "GTX-A",
]


def line_key(tags):
    ref = (tags.get("ref") or "").strip()
    if ref:
        return ref
    name = tags.get("name", "")
    for cand in NAME_KEY_CANDIDATES:
        if cand in name:
            return cand
    return None


def clean_line_name(name):
    """": 대화 → 오금" 류의 방향/지선 접미사를 제거"""
    return NAME_SUFFIX_RE.sub("", name).strip()


def sort_key_line(key):
    try:
        return (0, int(key), "")
    except ValueError:
        return (1, 0, key)


def build_subway_lines():
    raw = load_json(RAW_DIR / "subway_full.json")
    elements = raw["elements"]
    ways_by_id = {e["id"]: e for e in elements if e["type"] == "way"}
    relations = [e for e in elements if e["type"] == "relation"]

    groups = {}  # key -> {names:[], colours:[], way_ids:set, way_coords:[]}
    for rel in relations:
        tags = rel.get("tags", {})
        if tags.get("route") != "subway":
            continue
        key = line_key(tags)
        if not key:
            continue
        g = groups.setdefault(
            key, {"names": [], "colours": [], "way_ids": set(), "way_coords": []}
        )
        name = tags.get("name")
        if name:
            g["names"].append(clean_line_name(name))
        colour = tags.get("colour")
        if colour:
            g["colours"].append(colour)
        for m in rel.get("members", []):
            if m.get("type") != "way":
                continue
            wid = m.get("ref")
            if wid in g["way_ids"]:
                continue
            way = ways_by_id.get(wid)
            if not way or "geometry" not in way:
                continue
            g["way_ids"].add(wid)
            coords = [[r5(pt["lon"]), r5(pt["lat"])] for pt in way["geometry"]]
            if len(coords) >= 2:
                g["way_coords"].append(coords)

    features = []
    table_rows = []
    for key in sorted(groups.keys(), key=sort_key_line):
        g = groups[key]
        name = min(g["names"], key=len) if g["names"] else key
        colour = g["colours"][0] if g["colours"] else "#888888"
        ways_count = len(g["way_coords"])
        props = {"line": key, "name": name, "colour": colour, "ways": ways_count}
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "MultiLineString", "coordinates": g["way_coords"]},
            }
        )
        table_rows.append((key, name, colour, ways_count))

    return {"type": "FeatureCollection", "features": features}, table_rows


# ---------------------------------------------------------------------------
# 3. subway_stations.geojson
# ---------------------------------------------------------------------------

def build_subway_stations():
    raw = load_json(RAW_DIR / "subway_stations.json")
    elements = raw["elements"]
    seen = set()
    features = []
    points = []  # (lon, lat) full precision, for gu station counting
    for e in elements:
        if e["type"] != "node":
            continue
        tags = e.get("tags", {})
        if tags.get("railway") != "station":
            continue
        name = tags.get("name")
        lon, lat = e.get("lon"), e.get("lat")
        if name is None or lon is None or lat is None:
            continue
        dedup_key = (name, round(lon, 3), round(lat, 3))
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        points.append((lon, lat))
        props = {
            "name": name,
            "name_en": tags.get("name:en"),
            "network": tags.get("network"),
        }
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Point", "coordinates": [r5(lon), r5(lat)]},
            }
        )
    return {"type": "FeatureCollection", "features": features}, points


# ---------------------------------------------------------------------------
# 4. landmarks.json
# ---------------------------------------------------------------------------

def parse_height(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 1)
    s = re.sub(r"\s*(meters|m)\s*$", "", str(v).strip(), flags=re.IGNORECASE).strip()
    try:
        return round(float(s), 1)
    except ValueError:
        return None


def parse_levels(v):
    if v is None:
        return None
    try:
        return int(float(str(v).strip()))
    except ValueError:
        return None


def slugify(name_en):
    s = name_en.split(";")[0].strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def element_loc(e):
    if "center" in e and e["center"]:
        return e["center"]["lon"], e["center"]["lat"]
    return e.get("lon"), e.get("lat")


LANDMARK_SPEC = [
    ("롯데월드타워", "relation", 8824257, "tower", None),
    ("N서울타워", None, None, "tower",
     {"lon": 126.98817, "lat": 37.55127, "height": 236.7, "name_en": "N Seoul Tower"}),
    ("63스퀘어", "way", 463384209, "tower", None),
    ("파르나스타워", "way", 837196098, "tower", None),
    ("경복궁", "relation", 5501517, "palace", None),
    ("창덕궁", "way", 789965985, "palace", None),
    ("숭례문", "relation", 10647050, "gate", None),
    ("동대문디자인플라자", "relation", 10647068, "culture", None),
    ("서울특별시청", "way", 198561926, "civic", None),
    ("국회의사당", "way", 270596342, "civic", None),
    ("코엑스", "way", 74013220, "commerce", None),
    ("잠실야구장", "relation", 6114542, "stadium", None),
    ("서울월드컵경기장", "way", 168102974, "stadium", None),
    ("서울역", "node", 8829280690, "station", None),
    ("여의도공원", "way", 682334253, "park", None),
    ("북한산", None, None, "peak",
     {"lon": 126.99, "lat": 37.6587, "height": 836.0, "name_en": "Bukhansan"}),
]


def find_by_name(elements, name):
    for e in elements:
        if e.get("tags", {}).get("name") == name:
            return e
    return None


def find_peak_bukhansan(elements):
    for e in elements:
        t = e.get("tags", {})
        if t.get("natural") == "peak" and t.get("name") == "북한산":
            return e
    return None


def build_landmarks():
    raw = load_json(RAW_DIR / "landmarks.json")
    elements = raw["elements"]
    by_key = {(e["type"], e["id"]): e for e in elements}

    results = []
    for name, etype, eid, kind, fallback in LANDMARK_SPEC:
        e = None
        if etype is not None:
            e = by_key.get((etype, eid))
        else:
            if name == "N서울타워":
                e = find_by_name(elements, "N서울타워")
            elif name == "북한산":
                e = find_peak_bukhansan(elements)

        if e is not None:
            tags = e.get("tags", {})
            lon, lat = element_loc(e)
            name_en = tags.get("name:en") or (fallback or {}).get("name_en")
            height = parse_height(tags.get("height"))
            if height is None and fallback:
                height = fallback.get("height")
            levels = parse_levels(tags.get("building:levels"))
        else:
            fb = fallback or {}
            lon, lat = fb.get("lon"), fb.get("lat")
            name_en = fb.get("name_en")
            height = fb.get("height")
            levels = None

        landmark_id = slugify(name_en) if name_en else name
        results.append(
            {
                "id": landmark_id,
                "name": name,
                "name_en": name_en,
                "lon": r5(lon) if lon is not None else None,
                "lat": r5(lat) if lat is not None else None,
                "height": height,
                "levels": levels,
                "kind": kind,
            }
        )
    return results


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    stations_geojson, station_points = build_subway_stations()
    gu_geojson = build_seoul_gu(station_points)
    lines_geojson, table_rows = build_subway_lines()
    landmarks = build_landmarks()

    dump_json(gu_geojson, DATA_DIR / "seoul_gu.geojson")
    dump_json(lines_geojson, DATA_DIR / "subway_lines.geojson")
    dump_json(stations_geojson, DATA_DIR / "subway_stations.geojson")
    dump_json(landmarks, DATA_DIR / "landmarks.json")

    print(f"{'line':10s} {'name':30s} {'colour':10s} ways")
    for key, name, colour, ways in table_rows:
        print(f"{key:10s} {name:30s} {colour:10s} {ways}")

    print()
    print(f"seoul_gu features: {len(gu_geojson['features'])}")
    print(f"subway_lines features: {len(lines_geojson['features'])}")
    print(f"subway_stations features: {len(stations_geojson['features'])}")
    print(f"landmarks: {len(landmarks)}")

    for feat in gu_geojson["features"]:
        if feat["properties"]["name"] in ("강남구", "종로구"):
            print(feat["properties"]["name"], "stations:", feat["properties"]["stations"])


if __name__ == "__main__":
    main()
