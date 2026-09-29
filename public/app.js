const state = {
  stations: [],
  selectedStation: null,
  map: null,
  markers: new Map(),
  routeLayer: null
};

const els = {
  from: document.getElementById('from'),
  to: document.getElementById('to'),
  date: document.getElementById('travel-date'),
  dayType: document.getElementById('day-type'),
  stationPanel: document.getElementById('station-panel'),
  routeResult: document.getElementById('route-result'),
  search: document.getElementById('search'),
  swap: document.getElementById('swap')
};

function normalizeTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : text;
}

function minutesOf(time) {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.POSITIVE_INFINITY;
}

function durationMinutes(start, end) {
  let a = minutesOf(start);
  let b = minutesOf(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b < a) b += 1440;
  return b - a;
}

function durationLabel(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} sa ${m} dk` : `${m} dk`;
}

function sortSchedule(a, b) {
  return minutesOf(a.HareketSaati) - minutesOf(b.HareketSaati);
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = Number(options.timeout || 15000);
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || 'İstek başarısız');
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`İstek zaman aşımına uğradı (${timeout / 1000} sn).`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function sortedStations(stations) {
  return [...stations].sort((a, b) => Number(b.IstasyonSirasi) - Number(a.IstasyonSirasi));
}

function stationById(id) {
  return state.stations.find(s => Number(s.IstasyonId) === Number(id));
}

function todayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayTypeForDate(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getDay();
  if (day === 6) return 'Cumartesi';
  if (day === 0) return 'Pazar';
  return 'Hafta içi';
}

function formatTurkishDate(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateValue;
  return new Intl.DateTimeFormat('tr-TR', {
    day: '2-digit', month: 'long', year: 'numeric', weekday: 'long'
  }).format(date);
}

function updateDayType() {
  if (!els.date || !els.dayType) return;
  els.dayType.textContent = dayTypeForDate(els.date.value);
}

function buildSelectors() {
  const options = sortedStations(state.stations)
    .map(s => `<option value="${s.IstasyonId}">${s.IstasyonAdi}</option>`)
    .join('');
  els.from.innerHTML = options;
  els.to.innerHTML = options;
  const preferredFrom = state.stations.find(s => s.IstasyonAdi === 'Halkapınar')?.IstasyonId || state.stations[0]?.IstasyonId;
  const preferredTo = state.stations.find(s => s.IstasyonAdi === 'Aliağa')?.IstasyonId || state.stations[1]?.IstasyonId;
  els.from.value = preferredFrom;
  els.to.value = preferredTo;

  if (els.date) {
    els.date.value = todayIso();
    updateDayType();
  }
}

async function initMap() {
  if (typeof L === 'undefined') {
    throw new Error('Harita kütüphanesi yüklenemedi. İnternet bağlantısını ve Leaflet kaynağını kontrol et.');
  }

  state.map = L.map('map', {
    zoomControl: true,
    preferCanvas: true,
    scrollWheelZoom: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap katkıcıları</a>'
  }).addTo(state.map);

  const ordered = [...state.stations].sort((a, b) => Number(a.IstasyonSirasi) - Number(b.IstasyonSirasi));
  const stationCoords = ordered
    .map(s => [Number(s.Enlem), Number(s.Boylam)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

  // Harita ve istasyonlar hemen kuruluyor. Uzun sürebilen gerçek ray geometrisi
  // çağrısı arayüzü kilitlemiyor.
  if (stationCoords.length >= 2) {
    state.map.fitBounds(L.latLngBounds(stationCoords), { padding: [40, 40] });
  }

  ordered.forEach(station => {
    const marker = L.circleMarker([Number(station.Enlem), Number(station.Boylam)], {
      radius: 7,
      weight: 3,
      fillOpacity: 1,
      color: '#ffffff',
      fillColor: '#1769e0'
    }).addTo(state.map);

    marker.bindTooltip(station.IstasyonAdi, {
      direction: 'top',
      offset: [0, -7],
      sticky: true
    });
    marker.on('click', () => selectStation(station));
    state.markers.set(Number(station.IstasyonId), marker);
  });

  requestAnimationFrame(() => state.map.invalidateSize());
  loadRouteGeometry();
}

async function loadRouteGeometry() {
  try {
    const geometry = await api('/api/route-geometry', { timeout: 15000 });
    if (!geometry?.features?.length || !state.map) return;

    const casing = L.geoJSON(geometry, {
      style: {
        color: '#ffffff',
        weight: 12,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      },
      interactive: false
    }).addTo(state.map);

    const izbanLine = L.geoJSON(geometry, {
      style: {
        color: '#e11d48',
        weight: 8,
        opacity: 0.99,
        lineCap: 'round',
        lineJoin: 'round'
      },
      interactive: false
    }).addTo(state.map);

    state.routeLayer = L.layerGroup([casing, izbanLine]).addTo(state.map);
    const bounds = L.geoJSON(geometry).getBounds();
    if (bounds.isValid()) state.map.fitBounds(bounds, { padding: [40, 40] });
    requestAnimationFrame(() => state.map.invalidateSize());
  } catch (error) {
    console.warn('Gerçek İZBAN geometrisi yüklenemedi:', error.message);
    // İstasyonlar ve etkileşimler yine çalışır; yanlış/düz bir çizgi çizilmez.
  }
}

function highlightMarker(id) {
  state.markers.forEach((marker, stationId) => {
    marker.setStyle(stationId === Number(id)
      ? { radius: 10, weight: 4, fillColor: '#0b4ea2' }
      : { radius: 7, weight: 3, fillColor: '#1769e0' });
  });
}

async function selectStation(station) {
  state.selectedStation = station;
  highlightMarker(station.IstasyonId);
  els.stationPanel.innerHTML = `
    <div class="station-head">
      <div>
        <div class="eyebrow">İSTASYON</div>
        <div class="station-name">${station.IstasyonAdi}</div>
        <div class="station-meta">ID ${station.IstasyonId} · Güzergâh sırası ${station.IstasyonSirasi}</div>
      </div>
      <div class="source-pill">Planlanan tarife</div>
    </div>
    <div id="station-schedules"><div class="loading">Günün tüm planlı seferleri yükleniyor…</div></div>
  `;

  try {
    const response = await api(`/api/station-departures?station=${station.IstasyonId}&date=${todayIso()}`);
    renderStationSchedules(response?.items || []);
  } catch (error) {
    document.getElementById('station-schedules').innerHTML = `<div class="no-service">Sefer verisi alınamadı: ${error.message}</div>`;
  }
}

function renderStationSchedules(items) {
  const root = document.getElementById('station-schedules');
  if (!root) return;
  const sorted = [...(Array.isArray(items) ? items : [])].sort(sortSchedule);
  const rows = sorted.map(item => {
    const depart = normalizeTime(item.HareketSaati);
    const directionClass = item.yon === 'Kuzey' ? 'north' : 'south';
    return `
      <div class="schedule-row unified-row station-departure-row">
        <div class="time-block"><div class="departure">${depart || '—'}</div></div>
        <div class="destination-block">
          <div class="destination-label">${item.TrenSonIstasyonAdi || item.VarisIstasyonAdi || 'Varış bilinmiyor'}</div>
          <div class="direction-chip ${directionClass}">${item.yon || ''} yönü</div>
        </div>
        <div class="status-block"><span class="status planned-status">PLANLANDI</span></div>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <div class="schedule-summary">
      <div><strong>Günün tüm seferleri</strong><span>sadece geçiş saati · saat sırasına göre</span></div>
      <span class="count">${sorted.length} sefer</span>
    </div>
    <div class="schedule-list unified-schedule-list">
      ${rows || '<div class="no-service">Bu istasyon için planlı sefer bulunamadı.</div>'}
    </div>
  `;
}

function tripCard(item) {
  const depart = normalizeTime(item.HareketSaati);
  const arrive = normalizeTime(item.VarisSaati);
  const destination = item.VarisIstasyonAdi || 'Varış bilinmiyor';
  const finalDestination = item.TrenSonIstasyonAdi || item.headsign || destination;
  const duration = depart && arrive ? durationLabel(durationMinutes(depart, arrive)) : '';

  return `
    <div class="trip-card">
      <div class="trip-time-block">
        <div class="trip-label">Kalkış</div>
        <div class="trip-time">${depart || '—'}</div>
      </div>
      <div class="trip-middle">
        <div class="trip-dest">${destination}</div>
        <div class="trip-arrow">→</div>
        <div class="trip-final"><span>Trenin son istasyonu</span><strong>${finalDestination}</strong></div>
        <div class="trip-status">PLANLANDI${duration ? ` · ${duration}` : ''}</div>
      </div>
      <div class="trip-arrival-block">
        <div class="trip-label">Varış</div>
        <div class="trip-arrival-time">${arrive || '—'}</div>
      </div>
    </div>
  `;
}

async function searchRoute() {
  const from = Number(els.from.value);
  const to = Number(els.to.value);
  const date = els.date.value;
  const a = stationById(from);
  const b = stationById(to);
  if (!a || !b || from === to) {
    els.routeResult.innerHTML = '<div class="no-service">Farklı iki istasyon seçmelisin.</div>';
    return;
  }
  if (!date) {
    els.routeResult.innerHTML = '<div class="no-service">Lütfen bir tarih seç.</div>';
    return;
  }

  els.routeResult.innerHTML = '<div class="loading">Seçtiğin tarihin tüm planlı seferleri yükleniyor…</div>';
  try {
    const response = await api(`/api/schedule?from=${from}&to=${to}&date=${encodeURIComponent(date)}`);
    const items = Array.isArray(response) ? response : (response?.items || []);
    const sorted = items.map(x => ({
      ...x,
      HareketSaati: normalizeTime(x.HareketSaati),
      VarisSaati: normalizeTime(x.VarisSaati)
    })).filter(x => x.HareketSaati && x.VarisSaati).sort(sortSchedule);

    const rows = sorted.length
      ? sorted.map(tripCard).join('')
      : '<div class="no-service">Seçilen tarihte bu iki istasyon arasında sefer bulunamadı.</div>';

    const sourceNote = response?.dateSupported === false
      ? '<div class="route-warning">Bu sonuçlar resmi sefer API’sinin sunduğu tarifeden geliyor. Bu API tarih parametresi sunmadığı için seçilen tarih ekranda gösteriliyor, ancak tarih bazlı saat filtresi uygulanamıyor.</div>'
      : '';

    els.routeResult.innerHTML = `
      <div class="result-head">
        <div>
          <div class="eyebrow">PLANLI SEFERLER</div>
          <div class="result-title">${a.IstasyonAdi} → ${b.IstasyonAdi}</div>
          <div class="result-meta result-date">${formatTurkishDate(date)} · ${dayTypeForDate(date)}</div>
        </div>
        <div class="result-meta">${sorted.length} sefer</div>
      </div>
      ${sourceNote}
      <div>${rows}</div>
    `;
  } catch (error) {
    els.routeResult.innerHTML = `<div class="no-service">Sefer verisi alınamadı: ${error.message}</div>`;
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(x => x.classList.remove('active'));
      button.classList.add('active');
      document.getElementById(`tab-${button.dataset.tab}`).classList.add('active');
      if (button.dataset.tab === 'map') setTimeout(() => state.map.invalidateSize(), 50);
    });
  });
}

els.swap.addEventListener('click', () => {
  const currentFrom = els.from.value;
  els.from.value = els.to.value;
  els.to.value = currentFrom;
});
els.search.addEventListener('click', searchRoute);
els.date.addEventListener('change', updateDayType);

(async function bootstrap() {
  try {
    state.stations = sortedStations(await api('/api/stations'));
    buildSelectors();
    await initMap();
    setupTabs();
  } catch (error) {
    document.querySelector('main').innerHTML = `<div class="side-card" style="padding:24px"><h2>Veriler yüklenemedi</h2><p>${error.message}</p></div>`;
  }
})();
