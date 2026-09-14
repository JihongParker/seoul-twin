/* 서울 트윈 - MapLibre GL JS 기반 3D 디지털 트윈. 빌드 없음, 키 없음. */
(function () {
  'use strict';

  const STYLE_DAY = 'https://tiles.openfreemap.org/styles/liberty';
  const STYLE_NIGHT = 'https://tiles.openfreemap.org/styles/fiord';
  const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const HOME = { center: [126.992, 37.535], zoom: 13.2, pitch: 62, bearing: -18 };

  const $ = (id) => document.getElementById(id);
  const state = {
    hour: 14, night: false, minH: 0, opacity: 0.9, exag: 1.2,
    layers: { buildings: true, terrain: true, gu: true, subway: true, landmarks: true },
    lines: new Set(), rotating: false, touring: false, tourIdx: 0, hoverGu: null, selected: null,
    data: {}
  };

  const map = new maplibregl.Map({
    container: 'map',
    style: STYLE_DAY,
    center: HOME.center, zoom: HOME.zoom, pitch: HOME.pitch, bearing: HOME.bearing,
    hash: true, minZoom: 8, maxZoom: 19, maxPitch: 85,
    antialias: true,
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.FullscreenControl(), 'bottom-right');

  /* ---------- 데이터 ---------- */
  const loadJSON = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const dataReady = Promise.all([
    loadJSON('data/seoul_gu.geojson'), loadJSON('data/subway_lines.geojson'),
    loadJSON('data/subway_stations.geojson'), loadJSON('data/landmarks.json'), loadJSON('data/grok_notes.json')
  ]).then(([gu, lines, stations, landmarks, notes]) => {
    state.data = { gu, lines, stations, landmarks, notes };
    state.data.landmarksFC = {
      type: 'FeatureCollection',
      features: landmarks.map((l) => ({ type: 'Feature', properties: l, geometry: { type: 'Point', coordinates: [l.lon, l.lat] } }))
    };
    lines.features.forEach((f) => state.lines.add(f.properties.line));
    buildLinePanel(lines.features);
    buildSearchList();
  }).catch((e) => { console.error(e); alert('데이터를 불러오지 못했습니다: ' + e.message); });

  /* ---------- 층 구성 (스타일이 바뀔 때마다 다시 실행) ---------- */
  function buildingColor(night) {
    return night
      ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 5], 0, '#2a3242', 30, '#33405a', 80, '#3d5580', 150, '#4b70a8', 300, '#6a93d1']
      : ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 5], 0, '#d9dde3', 30, '#b9c6d6', 80, '#7fa3c9', 150, '#3f78b8', 300, '#1f4f8f'];
  }
  function buildingFilter() { return ['>=', ['coalesce', ['get', 'render_height'], 5], state.minH]; }

  function firstSymbolLayer() {
    const ls = map.getStyle().layers;
    for (const l of ls) if (l.type === 'symbol') return l.id;
    return undefined;
  }

  function addLayers() {
    const d = state.data;
    if (!d.gu) return;
    const style = map.getStyle();
    // 스타일 자체의 3D 건물층은 숨기고 우리 층으로 통일
    style.layers.forEach((l) => { if (l.type === 'fill-extrusion' && l.id !== 'twin-buildings') map.setLayoutProperty(l.id, 'visibility', 'none'); });

    if (!map.getSource('terrain-dem')) {
      const dem = { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 15,
        attribution: '지형 <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">AWS Terrain Tiles</a>' };
      map.addSource('terrain-dem', dem);
      map.addSource('hillshade-dem', Object.assign({}, dem, { attribution: '' }));
    }
    const labelAnchor = firstSymbolLayer();
    if (!map.getLayer('twin-hillshade')) {
      map.addLayer({ id: 'twin-hillshade', type: 'hillshade', source: 'hillshade-dem',
        paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#1d2733', 'hillshade-highlight-color': '#ffffff', 'hillshade-illumination-anchor': 'map' } }, labelAnchor);
    }
    applyTerrain();

    if (!map.getLayer('twin-buildings')) {
      map.addLayer({ id: 'twin-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 12,
        filter: buildingFilter(),
        paint: {
          'fill-extrusion-color': buildingColor(state.night),
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, ['coalesce', ['get', 'render_height'], 5]],
          'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, ['coalesce', ['get', 'render_min_height'], 0]],
          'fill-extrusion-opacity': state.opacity,
          'fill-extrusion-vertical-gradient': true
        } }, labelAnchor);
    }

    if (!map.getSource('gu')) map.addSource('gu', { type: 'geojson', data: d.gu, promoteId: 'code' });
    if (!map.getLayer('gu-fill')) {
      map.addLayer({ id: 'gu-fill', type: 'fill', source: 'gu', paint: {
        'fill-color': '#6fa8ff',
        'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.28, ['boolean', ['feature-state', 'hover'], false], 0.18, 0.05] } }, 'twin-buildings');
      map.addLayer({ id: 'gu-line', type: 'line', source: 'gu', paint: { 'line-color': '#6fa8ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 2.4], 'line-opacity': 0.8 } }, 'twin-buildings');
      map.addLayer({ id: 'gu-label', type: 'symbol', source: 'gu', maxzoom: 13.5, layout: {
        'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 16], 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': false },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1220', 'text-halo-width': 1.6 } });
    }

    if (!map.getSource('subway-lines')) map.addSource('subway-lines', { type: 'geojson', data: d.lines });
    if (!map.getSource('subway-stations')) map.addSource('subway-stations', { type: 'geojson', data: d.stations });
    if (!map.getLayer('subway-casing')) {
      const w = ['interpolate', ['linear'], ['zoom'], 9, 1.2, 13, 3.5, 16, 7];
      const wc = ['interpolate', ['linear'], ['zoom'], 9, 3.2, 13, 5.5, 16, 9];
      map.addLayer({ id: 'subway-casing', type: 'line', source: 'subway-lines', filter: lineFilter(), layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': wc, 'line-opacity': 0.55 } }, 'twin-buildings');
      map.addLayer({ id: 'subway-line', type: 'line', source: 'subway-lines', filter: lineFilter(), layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'colour'], 'line-width': w } }, 'twin-buildings');
      map.addLayer({ id: 'subway-station', type: 'circle', source: 'subway-stations', minzoom: 11, paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 5, 17, 8], 'circle-color': '#ffffff', 'circle-stroke-color': '#1f2a3a', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'subway-station-label', type: 'symbol', source: 'subway-stations', minzoom: 13.5, layout: {
        'text-field': ['get', 'name'], 'text-size': 12, 'text-font': ['Noto Sans Regular'], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0b1220', 'text-halo-width': 1.4 } });
    }

    if (!map.getSource('landmarks')) map.addSource('landmarks', { type: 'geojson', data: d.landmarksFC });
    if (!map.getLayer('landmark-pt')) {
      map.addLayer({ id: 'landmark-pt', type: 'circle', source: 'landmarks', paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 8], 'circle-color': '#ffb454', 'circle-stroke-color': '#3a2a00', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'landmark-label', type: 'symbol', source: 'landmarks', layout: {
        'text-field': ['get', 'name'], 'text-size': 13, 'text-font': ['Noto Sans Bold'], 'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-optional': true },
        paint: { 'text-color': '#ffd79a', 'text-halo-color': '#0b1220', 'text-halo-width': 1.6 } });
    }
    applyVisibility();
    applySky();
    applyLight();
    if (state.selected && state.selected.kind === 'gu') map.setFeatureState({ source: 'gu', id: state.selected.code }, { selected: true });
  }

  function lineFilter() { return ['in', ['get', 'line'], ['literal', Array.from(state.lines)]]; }

  function applyVisibility() {
    const v = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
    const L = state.layers;
    v('twin-buildings', L.buildings);
    v('twin-hillshade', L.terrain);
    ['gu-fill', 'gu-line', 'gu-label'].forEach((id) => v(id, L.gu));
    ['subway-casing', 'subway-line', 'subway-station', 'subway-station-label'].forEach((id) => v(id, L.subway));
    ['landmark-pt', 'landmark-label'].forEach((id) => v(id, L.landmarks));
  }
  function applyTerrain() {
    if (!map.getSource('terrain-dem')) return;
    if (state.layers.terrain && state.exag > 0) map.setTerrain({ source: 'terrain-dem', exaggeration: state.exag });
    else map.setTerrain(null);
  }
  function applySky() {
    const h = state.hour;
    const dusk = Math.min(1, Math.max(0, 1 - Math.abs(h - 12) / 7));
    const night = state.night;
    const skyC = night ? '#0a0f1e' : `rgb(${Math.round(120 + 50 * dusk)}, ${Math.round(150 + 60 * dusk)}, ${Math.round(200 + 40 * dusk)})`;
    const horC = night ? '#1b2340' : (dusk < 0.5 ? '#f0a86a' : '#cfe3f7');
    map.setSky({ 'sky-color': skyC, 'horizon-color': horC, 'fog-color': night ? '#0e1424' : '#c8d6e6',
      'fog-ground-blend': 0.6, 'horizon-fog-blend': 0.7, 'sky-horizon-blend': 0.75, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 1, 12, 0] });
  }
  function applyLight() {
    const h = state.hour;
    const t = (h - 6) / 12; // 0=일출, 1=일몰
    const alt = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 62; // 고도각
    const az = 90 + t * 180; // 동→남→서
    const polar = state.night ? 70 : Math.max(20, 90 - alt);
    map.setLight({ anchor: 'map', position: [1.4, az, polar], color: state.night ? '#9fb3ff' : (alt < 20 ? '#ffd2a8' : '#ffffff'), intensity: state.night ? 0.25 : 0.4 + 0.25 * (alt / 62) });
  }

  map.on('style.load', addLayers);
  map.on('load', () => dataReady.then(() => { addLayers(); setTimeout(() => $('splash').classList.add('done'), 400); }));

  /* ---------- 스타일 전환 (낮/밤) ---------- */
  function setNight(night) {
    if (night === state.night) return;
    state.night = night;
    map.setStyle(night ? STYLE_NIGHT : STYLE_DAY, { diff: false });
  }

  /* ---------- 상호작용 ---------- */
  const guByCode = () => Object.fromEntries(state.data.gu.features.map((f) => [f.properties.code, f]));

  map.on('mousemove', 'gu-fill', (e) => {
    const f = e.features[0];
    if (state.hoverGu !== null && state.hoverGu !== f.id) map.setFeatureState({ source: 'gu', id: state.hoverGu }, { hover: false });
    state.hoverGu = f.id;
    map.setFeatureState({ source: 'gu', id: f.id }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'gu-fill', () => {
    if (state.hoverGu !== null) map.setFeatureState({ source: 'gu', id: state.hoverGu }, { hover: false });
    state.hoverGu = null; map.getCanvas().style.cursor = '';
  });
  map.on('click', (e) => {
    const lm = map.queryRenderedFeatures(e.point, { layers: ['landmark-pt', 'landmark-label'].filter((l) => map.getLayer(l)) });
    if (lm.length) { showLandmark(lm[0].properties); return; }
    const st = map.queryRenderedFeatures(e.point, { layers: ['subway-station'].filter((l) => map.getLayer(l)) });
    if (st.length) { showStation(st[0]); return; }
    const gu = map.queryRenderedFeatures(e.point, { layers: ['gu-fill'].filter((l) => map.getLayer(l)) });
    if (gu.length) { selectGu(gu[0].properties.code, true); return; }
    hideInfo();
  });
  ['landmark-pt', 'subway-station'].forEach((id) => {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  });

  function bboxOf(geom) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => { if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); } else c.forEach(walk); };
    walk(geom.coordinates);
    return b;
  }
  function selectGu(code, fly) {
    const f = guByCode()[code]; if (!f) return;
    clearSelection();
    state.selected = { kind: 'gu', code };
    map.setFeatureState({ source: 'gu', id: code }, { selected: true });
    const p = f.properties;
    showInfo('자치구', p.name + ' ' + p.name_eng, state.data.notes[p.name] || '', [
      ['면적', p.area_km2 + ' km²'], ['지하철역', p.stations + '곳 (OpenStreetMap)'], ['중심', p.centroid[1].toFixed(4) + ', ' + p.centroid[0].toFixed(4)]
    ]);
    if (fly) map.fitBounds(bboxOf(f.geometry), { padding: { top: 90, left: panelOpen() ? 330 : 40, right: 350, bottom: 60 }, pitch: 55, bearing: map.getBearing(), duration: 1400 });
  }
  function clearSelection() {
    if (state.selected && state.selected.kind === 'gu') map.setFeatureState({ source: 'gu', id: state.selected.code }, { selected: false });
    state.selected = null;
  }
  function showLandmark(p) {
    clearSelection(); state.selected = { kind: 'landmark', id: p.id };
    const facts = [];
    if (p.height) facts.push(['높이', p.height + ' m']);
    if (p.levels) facts.push(['층수', p.levels + '층']);
    facts.push(['좌표', (+p.lat).toFixed(5) + ', ' + (+p.lon).toFixed(5)]);
    showInfo(KIND[p.kind] || '랜드마크', p.name + (p.name_en ? ' · ' + p.name_en : ''), state.data.notes[p.name] || '', facts);
  }
  function showStation(f) {
    clearSelection();
    const p = f.properties;
    showInfo('지하철역', p.name + (p.name_en ? ' · ' + p.name_en : ''), p.network ? p.network + ' 소속 역이다.' : '', [['좌표', f.geometry.coordinates[1].toFixed(5) + ', ' + f.geometry.coordinates[0].toFixed(5)]]);
  }
  const KIND = { tower: '타워', palace: '궁궐', gate: '성문', culture: '문화', civic: '공공', commerce: '상업', stadium: '경기장', station: '역', park: '공원', peak: '산' };

  function showInfo(kicker, title, desc, facts) {
    $('info-kicker').textContent = kicker; $('info-title').textContent = title; $('info-desc').textContent = desc;
    const dl = $('info-facts'); dl.innerHTML = '';
    facts.forEach(([k, v]) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); });
    $('info').hidden = false;
  }
  function hideInfo() { $('info').hidden = true; clearSelection(); }
  $('info-close').onclick = hideInfo;

  /* ---------- 카메라: 자동 회전, 투어, 북쪽 ---------- */
  let rotRaf = null;
  function setRotate(on) {
    state.rotating = on; $('btn-rotate').classList.toggle('on', on);
    if (rotRaf) { cancelAnimationFrame(rotRaf); rotRaf = null; }
    if (!on) return;
    let last = performance.now();
    const step = (now) => { const dt = now - last; last = now; map.setBearing(map.getBearing() + dt * 0.006); rotRaf = requestAnimationFrame(step); };
    rotRaf = requestAnimationFrame(step);
  }
  ['mousedown', 'touchstart', 'wheel'].forEach((ev) => map.getCanvas().addEventListener(ev, () => { if (state.rotating && !state.touring) setRotate(false); }, { passive: true }));

  let tourTimer = null;
  function setTour(on) {
    state.touring = on; $('btn-tour').classList.toggle('on', on);
    clearTimeout(tourTimer); map.off('moveend', tourNext);
    if (!on) { setRotate(false); return; }
    tourStep();
  }
  function tourStep() {
    const lms = state.data.landmarks; if (!lms) return;
    const l = lms[state.tourIdx % lms.length]; state.tourIdx++;
    setRotate(false);
    showLandmark(l);
    map.flyTo({ center: [l.lon, l.lat], zoom: l.kind === 'peak' ? 13.5 : 16, pitch: l.kind === 'peak' ? 70 : 65, bearing: map.getBearing() + 60, speed: 0.7, curve: 1.4, essential: true });
    map.once('moveend', tourNext);
  }
  function tourNext() {
    if (!state.touring) return;
    setRotate(true);
    tourTimer = setTimeout(() => { if (state.touring) tourStep(); }, 4500);
  }
  $('btn-rotate').onclick = () => { if (state.touring) setTour(false); setRotate(!state.rotating); };
  $('btn-tour').onclick = () => setTour(!state.touring);
  $('btn-north').onclick = () => map.easeTo({ bearing: 0, pitch: 60, duration: 700 });

  /* ---------- 저장, 링크 ---------- */
  $('btn-shot').onclick = () => {
    map.once('render', () => {
      const a = document.createElement('a');
      a.download = 'seoul-twin_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
      a.href = map.getCanvas().toDataURL('image/png'); a.click();
    });
    map.triggerRepaint();
  };
  $('btn-share').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); flash($('btn-share'), '복사됨'); }
    catch (e) { prompt('링크', location.href); }
  };
  function flash(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => { btn.textContent = o; }, 1200); }

  /* ---------- 패널 ---------- */
  const panelOpen = () => !$('panel').classList.contains('hidden');
  $('btn-panel').onclick = () => $('panel').classList.toggle('hidden');
  if (window.innerWidth < 720) $('panel').classList.add('hidden');

  const bind = (id, key) => { $(id).onchange = (e) => { state.layers[key] = e.target.checked; applyVisibility(); if (key === 'terrain') applyTerrain(); }; };
  bind('ly-buildings', 'buildings'); bind('ly-terrain', 'terrain'); bind('ly-gu', 'gu'); bind('ly-subway', 'subway'); bind('ly-landmarks', 'landmarks');

  $('minh').oninput = (e) => { state.minH = +e.target.value; $('v-minh').textContent = state.minH + ' m 이상'; if (map.getLayer('twin-buildings')) map.setFilter('twin-buildings', buildingFilter()); };
  $('opac').oninput = (e) => { state.opacity = +e.target.value / 100; $('v-opac').textContent = e.target.value + '%'; if (map.getLayer('twin-buildings')) map.setPaintProperty('twin-buildings', 'fill-extrusion-opacity', state.opacity); };
  $('exag').oninput = (e) => { state.exag = +e.target.value; $('v-exag').textContent = state.exag.toFixed(1) + '배'; applyTerrain(); };
  $('hour').oninput = (e) => {
    state.hour = +e.target.value; $('v-hour').textContent = (Number.isInteger(state.hour) ? state.hour : Math.floor(state.hour) + ':30') + '시';
    const night = state.hour < 6 || state.hour > 19;
    if (night !== state.night) { setNight(night); return; }
    applySky(); applyLight();
    if (map.getLayer('twin-buildings')) map.setPaintProperty('twin-buildings', 'fill-extrusion-color', buildingColor(state.night));
  };

  function buildLinePanel(features) {
    const box = $('lines'); box.innerHTML = '';
    features.forEach((f) => {
      const p = f.properties;
      const lab = document.createElement('label'); lab.style.setProperty('--c', p.colour);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
      cb.onchange = () => { cb.checked ? state.lines.add(p.line) : state.lines.delete(p.line); ['subway-casing', 'subway-line'].forEach((id) => map.getLayer(id) && map.setFilter(id, lineFilter())); };
      const sw = document.createElement('i');
      lab.append(cb, sw, document.createTextNode(/^\d+$/.test(p.line) ? p.line + '호선' : p.line + '선'));
      box.append(lab);
    });
  }

  /* ---------- 검색 ---------- */
  const searchIndex = [];
  function buildSearchList() {
    const dl = $('search-list'); dl.innerHTML = '';
    const add = (name, fn) => { searchIndex.push({ name, fn }); const o = document.createElement('option'); o.value = name; dl.append(o); };
    state.data.gu.features.forEach((f) => add(f.properties.name, () => selectGu(f.properties.code, true)));
    state.data.landmarks.forEach((l) => add(l.name, () => { showLandmark(l); map.flyTo({ center: [l.lon, l.lat], zoom: l.kind === 'peak' ? 13.5 : 16.2, pitch: 65, duration: 2200 }); }));
    state.data.stations.features.forEach((f) => add(f.properties.name + '역', () => { showStation(f); map.flyTo({ center: f.geometry.coordinates, zoom: 16, pitch: 60, duration: 2200 }); }));
  }
  $('search').addEventListener('change', (e) => {
    const q = e.target.value.trim(); if (!q) return;
    const hit = searchIndex.find((s) => s.name === q) || searchIndex.find((s) => s.name.includes(q));
    if (hit) { hit.fn(); e.target.blur(); } else flashInput(e.target);
  });
  function flashInput(el) { el.style.borderColor = '#ff7a7a'; setTimeout(() => { el.style.borderColor = ''; }, 800); }

  /* ---------- 키보드 ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'r') $('btn-rotate').click();
    else if (k === 't') $('btn-tour').click();
    else if (k === 'n') $('btn-north').click();
    else if (k === 'p') $('btn-panel').click();
    else if (k === 'h') map.flyTo({ ...HOME, duration: 1800 });
    else if (k === 'escape') { hideInfo(); if (state.touring) setTour(false); }
  });

  /* ---------- 상태 표시 ---------- */
  function updateStatus() {
    const c = map.getCenter();
    $('st-pos').textContent = c.lat.toFixed(4) + ', ' + c.lng.toFixed(4) + ' · 줌 ' + map.getZoom().toFixed(1) + ' · 방위 ' + Math.round((map.getBearing() + 360) % 360) + '° · 기울기 ' + Math.round(map.getPitch()) + '°';
  }
  map.on('move', updateStatus); map.on('load', updateStatus);
  map.on('moveend', () => { $('btn-tiles').href = 'tiles.html' + location.hash; });

  /* ---------- Grok 질의 (사용자 본인 키) ---------- */
  const keyEl = $('xai-key');
  try { keyEl.value = localStorage.getItem('xai_key') || ''; } catch (e) { /* 저장소 차단 */ }
  keyEl.onchange = () => { try { localStorage.setItem('xai_key', keyEl.value.trim()); } catch (e) { /* 무시 */ } };
  $('xai-ask').onclick = async () => {
    const key = keyEl.value.trim(), q = $('xai-q').value.trim();
    const out = $('xai-a'); out.hidden = false;
    if (!key) { out.textContent = 'xAI API 키가 필요합니다. console.x.ai 에서 발급할 수 있습니다.'; return; }
    if (!q) { out.textContent = '질문을 입력하세요.'; return; }
    const c = map.getCenter();
    let ctx = `사용자는 서울 3D 지도를 보고 있다. 화면 중심 좌표 위도 ${c.lat.toFixed(4)}, 경도 ${c.lng.toFixed(4)}, 줌 ${map.getZoom().toFixed(1)}.`;
    if (state.selected && state.selected.kind === 'gu') ctx += ` 선택한 자치구: ${guByCode()[state.selected.code].properties.name}.`;
    if (state.selected && state.selected.kind === 'landmark') ctx += ` 선택한 랜드마크: ${$('info-title').textContent}.`;
    $('xai-ask').disabled = true; out.textContent = '검색 중입니다.';
    try {
      const r = await fetch('https://api.x.ai/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: 'grok-4.6', input: [{ role: 'system', content: ctx + ' 한국어로 간결하게, 사실 위주로 답하라. 이모지 금지.' }, { role: 'user', content: q }], tools: [{ type: 'web_search' }] }) });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      const msgs = (j.output || []).filter((o) => o.type === 'message');
      let text = '', cites = [];
      msgs.forEach((m) => (m.content || []).forEach((p) => { text += p.text || ''; (p.annotations || []).forEach((a) => { if (a.url) cites.push(a.url); }); }));
      if (!text) text = JSON.stringify(j).slice(0, 800);
      out.textContent = text;
      cites = Array.from(new Set(cites)).slice(0, 6);
      if (cites.length) { const d = document.createElement('div'); d.className = 'cites'; cites.forEach((u) => { const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel = 'noopener'; a.textContent = u; d.append(a); }); out.append(d); }
    } catch (e) { out.textContent = '실패: ' + e.message; }
    $('xai-ask').disabled = false;
  };

  window.twin = { map, state, selectGu, showLandmark, setTour, setRotate };
})();
