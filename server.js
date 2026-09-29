const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const STATIONS_API = 'https://openapi.izmir.bel.tr/api/izban/istasyonlar';
const SCHEDULE_API = 'https://openapi.izmir.bel.tr/api/izban/sefersaatleri';
const GTFS_URL = 'https://www.izban.com.tr/gtfs/rail-izban-gtfs.zip';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

let stationCache = null;
let stationCacheAt = 0;
let gtfsCache = null;
let gtfsCacheAt = 0;
const stationDepartureCache = new Map();
const DEPARTURE_CACHE_TTL = 5 * 60 * 1000;
const STATION_CACHE_TTL = 6 * 60 * 60 * 1000;
const GTFS_CACHE_TTL = 30 * 60 * 1000;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some(v => v !== '')) rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map(x => x.trim());
  return rows.slice(1).map(values => {
    const item = {};
    headers.forEach((header, idx) => { item[header] = (values[idx] ?? '').trim(); });
    return item;
  });
}

function readZipCsv(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) return [];
  return parseCsv(entry.getData().toString('utf8'));
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'izban-web/0.4',
      'Accept': 'application/zip,application/octet-stream,*/*'
    }
  });
  if (!response.ok) throw new Error(`GTFS ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const m = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function normalizeTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function timeMinutes(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * 60 + Number(match[2]);
}

function displayTime(value) {
  const raw = normalizeTime(value);
  if (!raw) return null;
  let minutes = timeMinutes(raw);
  minutes = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function dateParts(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return {
    year,
    month,
    day,
    iso: dateString,
    weekday: dt.getUTCDay(),
    weekdayField: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dt.getUTCDay()]
  };
}

function isDateWithin(date, start, end) {
  return date >= start && date <= end;
}

function activeServiceIds(gtfs, dateString) {
  const date = dateParts(dateString);
  const ids = new Set();

  for (const row of gtfs.calendar) {
    const start = normalizeDate(row.start_date);
    const end = normalizeDate(row.end_date);
    if (!start || !end || !isDateWithin(date.iso, start, end)) continue;
    if (row[date.weekdayField] === '1') ids.add(row.service_id);
  }

  for (const row of gtfs.calendarDates) {
    if (normalizeDate(row.date) !== date.iso) continue;
    if (row.exception_type === '1') ids.add(row.service_id);
    if (row.exception_type === '2') ids.delete(row.service_id);
  }

  return ids;
}

function buildGtfsModel(zip) {
  const stops = readZipCsv(zip, 'stops.txt');
  const routes = readZipCsv(zip, 'routes.txt');
  const trips = readZipCsv(zip, 'trips.txt');
  const calendar = readZipCsv(zip, 'calendar.txt');
  const calendarDates = readZipCsv(zip, 'calendar_dates.txt');
  const stopTimes = readZipCsv(zip, 'stop_times.txt');
  const shapes = readZipCsv(zip, 'shapes.txt');

  const stopById = new Map(stops.map(x => [x.stop_id, x]));
  const routeById = new Map(routes.map(x => [x.route_id, x]));
  const tripById = new Map(trips.map(x => [x.trip_id, x]));
  const stopTimesByTrip = new Map();

  for (const row of stopTimes) {
    if (!stopTimesByTrip.has(row.trip_id)) stopTimesByTrip.set(row.trip_id, []);
    stopTimesByTrip.get(row.trip_id).push(row);
  }
  for (const list of stopTimesByTrip.values()) {
    list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  }

  const shapesById = new Map();
  for (const row of shapes) {
    if (!shapesById.has(row.shape_id)) shapesById.set(row.shape_id, []);
    shapesById.get(row.shape_id).push(row);
  }
  for (const list of shapesById.values()) {
    list.sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence));
  }

  return {
    stops,
    routes,
    trips,
    calendar,
    calendarDates,
    stopTimes,
    shapes,
    stopById,
    routeById,
    tripById,
    stopTimesByTrip,
    shapesById
  };
}

async function getGtfs() {
  const now = Date.now();
  if (gtfsCache && now - gtfsCacheAt < GTFS_CACHE_TTL) return gtfsCache;

  const buffer = await fetchBuffer(GTFS_URL);
  const zip = new AdmZip(buffer);
  gtfsCache = buildGtfsModel(zip);
  gtfsCacheAt = now;
  return gtfsCache;
}

async function getStations() {
  const now = Date.now();
  if (stationCache && now - stationCacheAt < STATION_CACHE_TTL) return stationCache;
  try {
    const response = await fetch(STATIONS_API, { headers: { 'User-Agent': 'izban-web/0.4' } });
    if (!response.ok) throw new Error(`Stations API ${response.status}`);
    stationCache = await response.json();
    stationCacheAt = now;
    return stationCache;
  } catch (error) {
    const fallback = JSON.parse(fs.readFileSync(path.join(ROOT, 'stations-fallback.json'), 'utf8'));
    stationCache = fallback;
    stationCacheAt = now;
    console.warn('İstasyon API erişilemedi; yerel fallback kullanılıyor:', error.message);
    return fallback;
  }
}

async function getScheduleFallback(from, to) {
  const url = `${SCHEDULE_API}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'izban-web/0.5', Accept: 'application/json' }
  });
  if (response.status === 204) return [];
  const text = await response.text();
  if (!response.ok) throw new Error(`Schedule API ${response.status}: ${text.slice(0, 200)}`);
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed?.SeferSaatleri || []);
}

function cleanScheduleItems(data) {
  return (Array.isArray(data) ? data : (data?.SeferSaatleri || []))
    .map(item => ({
      ...item,
      HareketSaati: displayTime(item.HareketSaati),
      VarisSaati: displayTime(item.VarisSaati)
    }))
    .filter(item => item.HareketSaati);
}

const FINAL_DESTINATION_NAMES = [
  'Aliağa', 'Menemen', 'Çiğli', 'Halkapınar', 'Alsancak',
  'Cumaovası', 'Tepeköy', 'Selçuk', 'Gaziemir'
];

function stationSequence(station) {
  return Number(station?.IstasyonSirasi);
}

function sameDirectionCandidate(origin, target, candidate) {
  const o = stationSequence(origin);
  const t = stationSequence(target);
  const c = stationSequence(candidate);
  if (![o, t, c].every(Number.isFinite)) return false;
  if (t === o || c === o) return false;
  const dir = Math.sign(t - o);
  if (dir > 0) return c >= t;
  if (dir < 0) return c <= t;
  return false;
}

async function attachFinalDestinations(fromStation, toStation, items, stations) {
  if (!items.length) return items;
  const candidates = FINAL_DESTINATION_NAMES
    .map(name => stations.find(s => stationAliases(s.IstasyonAdi) === stationAliases(name)))
    .filter(Boolean)
    .filter(candidate => sameDirectionCandidate(fromStation, toStation, candidate));

  if (!candidates.length) return items.map(item => ({ ...item, TrenSonIstasyonAdi: item.VarisIstasyonAdi || 'Bilinmiyor' }));

  const results = await Promise.allSettled(
    candidates.map(async candidate => ({
      candidate,
      items: cleanScheduleItems(await getScheduleFallback(fromStation.IstasyonId, candidate.IstasyonId))
    }))
  );

  const endpointByDeparture = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { candidate, items: endpointItems } = result.value;
    const seq = stationSequence(candidate);
    for (const item of endpointItems) {
      const key = item.HareketSaati;
      const prev = endpointByDeparture.get(key);
      if (!prev || Math.abs(seq - stationSequence(fromStation)) > prev.distance) {
        endpointByDeparture.set(key, {
          name: candidate.IstasyonAdi,
          distance: Math.abs(seq - stationSequence(fromStation))
        });
      }
    }
  }

  return items.map(item => ({
    ...item,
    TrenSonIstasyonAdi: endpointByDeparture.get(item.HareketSaati)?.name || item.VarisIstasyonAdi || 'Bilinmiyor'
  }));
}

function stationAliases(name) {
  return String(name || '').trim().toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
}

function gtfsStopMatchesStation(gtfs, station) {
  const wanted = stationAliases(station.IstasyonAdi);
  return gtfs.stops.filter(stop => stationAliases(stop.stop_name) === wanted);
}

function findTripLeg(gtfs, trip, fromStation, toStation) {
  const fromStops = new Set(gtfsStopMatchesStation(gtfs, fromStation).map(s => s.stop_id));
  const toStops = new Set(gtfsStopMatchesStation(gtfs, toStation).map(s => s.stop_id));
  const times = gtfs.stopTimesByTrip.get(trip.trip_id) || [];
  const fromTime = times.find(x => fromStops.has(x.stop_id));
  const toTime = times.find(x => toStops.has(x.stop_id));
  if (!fromTime || !toTime) return null;
  if (Number(fromTime.stop_sequence) >= Number(toTime.stop_sequence)) return null;
  return { fromTime, toTime, times };
}

function finalStopForTrip(gtfs, times) {
  const final = times[times.length - 1];
  return final ? gtfs.stopById.get(final.stop_id) : null;
}

function stationByName(stations, name) {
  if (!name) return null;
  const wanted = stationAliases(name);
  return stations.find(s => stationAliases(s.IstasyonAdi) === wanted) || null;
}

function deriveTripFinalStation(gtfs, trip, times, fromStation, toStation, stations) {
  // Öncelik: GTFS stop_times dizisinin gerçek son durağı. Bu, seçilen ara varış
  // istasyonuyla karışmaz ve Naldöken → Turan gibi ters yönlü sorgularda doğru
  // tren sonunu korur.
  const terminalStop = finalStopForTrip(gtfs, times);
  const terminalStation = stationByName(stations, terminalStop?.stop_name);
  if (terminalStation) return terminalStation;

  // Bazı GTFS kayıtlarında son stop adı istasyon listesiyle birebir eşleşmeyebilir.
  // Bu durumda operatörün trip_headsign bilgisini güvenilir ikinci kaynak olarak kullan.
  const headsignStation = stationByName(stations, trip.trip_headsign);
  if (headsignStation) return headsignStation;

  // Son çare: yolculuk yönüne göre trip içindeki en uç tanınan istasyonu bul.
  const fromSeq = stationSequence(fromStation);
  const toSeq = stationSequence(toStation);
  const direction = Number.isFinite(fromSeq) && Number.isFinite(toSeq)
    ? Math.sign(toSeq - fromSeq) : 0;

  const tripStations = times
    .map(row => stationByName(stations, gtfs.stopById.get(row.stop_id)?.stop_name))
    .filter(Boolean)
    .filter((station, idx, arr) => arr.findIndex(x => Number(x.IstasyonId) === Number(station.IstasyonId)) === idx);

  if (tripStations.length && direction) {
    const directed = tripStations.filter(station => stationSequence(station) !== fromSeq);
    if (directed.length) {
      return direction > 0
        ? directed.reduce((best, station) => stationSequence(station) > stationSequence(best) ? station : best)
        : directed.reduce((best, station) => stationSequence(station) < stationSequence(best) ? station : best);
    }
  }

  return terminalStop;
}

function sortByRawDeparture(a, b) {
  return timeMinutes(a.rawDeparture) - timeMinutes(b.rawDeparture);
}

async function getDateRouteSchedule(from, to, dateString) {
  const stations = await getStations();
  const fromStation = stations.find(s => Number(s.IstasyonId) === Number(from));
  const toStation = stations.find(s => Number(s.IstasyonId) === Number(to));
  if (!fromStation || !toStation) throw new Error('İstasyon bulunamadı.');

  // Önce tarih destekleyen GTFS'i dene. Verinin güncel/erişilebilir olmaması halinde,
  // daha önce çalışan resmi web servisine düşerek sefer saatlerini kaybetmemeyi sağlarız.
  try {
    const gtfs = await getGtfs();
    const serviceIds = activeServiceIds(gtfs, dateString);
    const items = [];
    const seen = new Set();

    for (const trip of gtfs.trips) {
      if (!serviceIds.has(trip.service_id)) continue;
      const leg = findTripLeg(gtfs, trip, fromStation, toStation);
      if (!leg) continue;
      const finalStation = deriveTripFinalStation(gtfs, trip, leg.times, fromStation, toStation, stations);
      const finalStop = finalStation || finalStopForTrip(gtfs, leg.times);
      const route = gtfs.routeById.get(trip.route_id);
      const key = `${trip.trip_id}|${leg.fromTime.departure_time}|${leg.toTime.arrival_time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        tripId: trip.trip_id,
        routeId: trip.route_id,
        routeName: route?.route_long_name || route?.route_short_name || 'İZBAN',
        headsign: trip.trip_headsign || finalStation?.IstasyonAdi || finalStop?.stop_name || '',
        HareketIstasyonId: fromStation.IstasyonId,
        HareketIstasyonAdi: fromStation.IstasyonAdi,
        VarisIstasyonId: toStation.IstasyonId,
        VarisIstasyonAdi: toStation.IstasyonAdi,
        HareketSaati: displayTime(leg.fromTime.departure_time),
        VarisSaati: displayTime(leg.toTime.arrival_time),
        rawDeparture: leg.fromTime.departure_time,
        rawArrival: leg.toTime.arrival_time,
        TrenSonIstasyonAdi: finalStation?.IstasyonAdi || trip.trip_headsign || finalStop?.stop_name || 'Bilinmiyor'
      });
    }

    if (items.length) {
      items.sort(sortByRawDeparture);

      // GTFS trip kaydı gerçek tren seferini temsil ediyor. Bu nedenle trenin son
      // istasyonunu legacy API'deki saat eşleştirmesiyle yeniden ezmiyoruz.
      const cleaned = items.map(({ rawDeparture, rawArrival, ...item }) => item);

      return {
        items: cleaned,
        source: 'official-gtfs',
        dateSupported: true
      };
    }
  } catch (error) {
    console.warn('GTFS tarihli rota seferi kullanılamadı:', error.message);
  }

  const legacy = cleanScheduleItems(await getScheduleFallback(from, to));
  const annotated = await attachFinalDestinations(fromStation, toStation, legacy, stations);
  annotated.sort((a, b) => timeMinutes(a.HareketSaati) - timeMinutes(b.HareketSaati));
  return {
    items: annotated,
    source: 'legacy-api-fallback',
    dateSupported: false,
    warning: 'Resmi sefer API’si tarih parametresi sunmadığı için seçilen tarih yalnızca ekranda gösterilir; saatler API’nin sunduğu tarifeden gelir.'
  };
}

async function getLegacyStationDepartures(stationId) {
  const stations = await getStations();
  const station = stations.find(s => Number(s.IstasyonId) === Number(stationId));
  if (!station) throw new Error('İstasyon bulunamadı.');

  const candidates = FINAL_DESTINATION_NAMES
    .map(name => stations.find(s => stationAliases(s.IstasyonAdi) === stationAliases(name)))
    .filter(Boolean)
    .filter(s => Number(s.IstasyonId) !== Number(stationId));

  const results = await Promise.allSettled(
    candidates.map(async destination => ({
      destination,
      data: cleanScheduleItems(await getScheduleFallback(station.IstasyonId, destination.IstasyonId))
    }))
  );

  const byDeparture = new Map();
  const originSeq = stationSequence(station);
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { destination, data } = result.value;
    const destinationSeq = stationSequence(destination);
    if (!Number.isFinite(originSeq) || !Number.isFinite(destinationSeq) || destinationSeq === originSeq) continue;
    const direction = destinationSeq > originSeq ? 'Kuzey' : 'Güney';
    const distance = Math.abs(destinationSeq - originSeq);
    for (const item of data) {
      const key = item.HareketSaati;
      const candidate = {
        HareketSaati: item.HareketSaati,
        VarisIstasyonAdi: destination.IstasyonAdi,
        VarisSaati: item.VarisSaati || null,
        yon: direction,
        distance,
        TrenSonIstasyonAdi: destination.IstasyonAdi
      };
      const prev = byDeparture.get(key);
      if (!prev || distance > prev.distance) byDeparture.set(key, candidate);
    }
  }

  return [...byDeparture.values()]
    .sort((a, b) => timeMinutes(a.HareketSaati) - timeMinutes(b.HareketSaati))
    .map(({ distance, ...item }) => item);
}

async function getStationDateDepartures(stationId, dateString) {
  const cacheKey = `${Number(stationId)}|${dateString}`;
  const now = Date.now();
  const cached = stationDepartureCache.get(cacheKey);
  if (cached && now - cached.at < DEPARTURE_CACHE_TTL) return cached.data;

  try {
    const stations = await getStations();
    const station = stations.find(s => Number(s.IstasyonId) === Number(stationId));
    if (!station) throw new Error('İstasyon bulunamadı.');
    const gtfs = await getGtfs();
    const serviceIds = activeServiceIds(gtfs, dateString);
    const stationStopIds = new Set(gtfsStopMatchesStation(gtfs, station).map(s => s.stop_id));
    const seq = Number(station.IstasyonSirasi);
    const items = [];
    const seen = new Set();

    for (const trip of gtfs.trips) {
      if (!serviceIds.has(trip.service_id)) continue;
      const times = gtfs.stopTimesByTrip.get(trip.trip_id) || [];
      const atStation = times.find(x => stationStopIds.has(x.stop_id));
      if (!atStation) continue;
      const headsignStation = stationByName(stations, trip.trip_headsign);
      const headsignSeq = stationSequence(headsignStation);
      let stationFinal = null;
      if (headsignStation && Number.isFinite(headsignSeq) && Number.isFinite(seq) && headsignSeq !== seq) {
        stationFinal = headsignStation;
      } else {
        const tripStations = times
          .map(row => stationByName(stations, gtfs.stopById.get(row.stop_id)?.stop_name))
          .filter(Boolean);
        const directed = tripStations.filter(x => stationSequence(x) !== seq);
        if (directed.length) {
          stationFinal = seq < stationSequence(directed[0])
            ? directed.reduce((best, x) => stationSequence(x) > stationSequence(best) ? x : best)
            : directed.reduce((best, x) => stationSequence(x) < stationSequence(best) ? x : best);
        }
      }
      const finalStop = stationFinal ? { stop_name: stationFinal.IstasyonAdi } : finalStopForTrip(gtfs, times);
      const finalSeq = Number(stationFinal?.IstasyonSirasi);
      const yon = Number.isFinite(finalSeq) && Number.isFinite(seq)
        ? (finalSeq > seq ? 'Kuzey' : 'Güney') : '';
      const departure = displayTime(atStation.departure_time);
      const key = `${atStation.departure_time}|${stationFinal?.IstasyonAdi || finalStop?.stop_name || trip.trip_headsign || ''}`;
      if (!departure || seen.has(key)) continue;
      seen.add(key);
      items.push({
        HareketSaati: departure,
        VarisIstasyonAdi: finalStop?.stop_name || trip.trip_headsign || 'Varış bilinmiyor',
        yon,
        TrenSonIstasyonAdi: stationFinal?.IstasyonAdi || trip.trip_headsign || finalStop?.stop_name || 'Bilinmiyor'
      });
    }

    if (items.length) {
      items.sort((a, b) => timeMinutes(a.HareketSaati) - timeMinutes(b.HareketSaati));
      stationDepartureCache.set(cacheKey, { at: now, data: items });
      return items;
    }
  } catch (error) {
    console.warn('GTFS istasyon seferleri kullanılamadı:', error.message);
  }

  const legacy = await getLegacyStationDepartures(stationId);
  stationDepartureCache.set(cacheKey, { at: now, data: legacy });
  return legacy;
}

const ROUTE_CACHE_TTL = 12 * 60 * 60 * 1000;
let routeGeometryCache = null;
let routeGeometryCacheAt = 0;

function shapeDistanceMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

function buildGtfsShapeGeometry(gtfs, stations) {
  const stationSeqByName = new Map(stations.map(s => [stationAliases(s.IstasyonAdi), Number(s.IstasyonSirasi)]));
  const northSeq = stationSeqByName.get(stationAliases('Aliağa'));
  const southSeq = stationSeqByName.get(stationAliases('Selçuk'));
  const byShape = new Map();

  for (const trip of gtfs.trips) {
    const shapeId = trip.shape_id;
    if (!shapeId || !gtfs.shapesById.has(shapeId)) continue;
    const times = gtfs.stopTimesByTrip.get(trip.trip_id) || [];
    const seqs = times.map(row => stationSeqByName.get(stationAliases(gtfs.stopById.get(row.stop_id)?.stop_name)))
      .filter(Number.isFinite);
    if (seqs.length < 8) continue;
    const minSeq = Math.min(...seqs);
    const maxSeq = Math.max(...seqs);
    const span = maxSeq - minSeq;
    const reachesBothEnds = Number.isFinite(northSeq) && Number.isFinite(southSeq)
      && minSeq <= southSeq && maxSeq >= northSeq;
    const record = byShape.get(shapeId) || { shapeId, span: 0, reachesBothEnds: false };
    if (span > record.span) record.span = span;
    record.reachesBothEnds ||= reachesBothEnds;
    byShape.set(shapeId, record);
  }

  const candidates = [];
  for (const record of byShape.values()) {
    const points = gtfs.shapesById.get(record.shapeId)
      .map(row => ({ lat: Number(row.shape_pt_lat), lon: Number(row.shape_pt_lon) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (points.length < 100) continue;
    candidates.push({ ...record, distance: shapeDistanceMeters(points), points });
  }

  if (!candidates.length) throw new Error('GTFS shapes.txt içinde kullanılabilir İZBAN geometrisi bulunamadı.');
  candidates.sort((a, b) => Number(b.reachesBothEnds) - Number(a.reachesBothEnds) || b.span - a.span || b.distance - a.distance);
  const chosen = candidates[0];

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'İZBAN', source: 'İZBAN resmi GTFS shapes.txt', shapeId: chosen.shapeId },
      geometry: { type: 'LineString', coordinates: chosen.points.map(p => [p.lon, p.lat]) }
    }]
  };
}

async function fetchIzbanRouteRelations(stations) {
  const coords = stations.map(s => [Number(s.Enlem), Number(s.Boylam)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (coords.length < 2) throw new Error('İstasyon koordinatları bulunamadı.');
  const lats = coords.map(x => x[0]);
  const lons = coords.map(x => x[1]);
  const south = Math.min(...lats) - 0.03;
  const north = Math.max(...lats) + 0.03;
  const west = Math.min(...lons) - 0.03;
  const east = Math.max(...lons) + 0.03;

  // Yalnızca İZBAN adına/ağ adına/operator etiketine sahip route=train
  // ilişkilerinin ray elemanlarını al. Böylece TCDD ve diğer demiryolları
  // haritaya karışmaz; aynı zamanda gerçek rayın kıvrımları korunur.
  const query = `[out:json][timeout:90];(
    relation["type"="route"]["route"="train"]["network"~"izban","i"](${south},${west},${north},${east});
    relation["type"="route"]["route"="train"]["operator"~"izban","i"](${south},${west},${north},${east});
    relation["type"="route"]["route"="train"]["name"~"izban","i"](${south},${west},${north},${east});
  );(._;>;);out body geom;`;

  let lastError = null;
  for (const endpoint of OVERPASS_URLS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'izban-web/0.8',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({ data: query }).toString()
      });
      if (!response.ok) throw new Error(`${endpoint} -> ${response.status}`);
      const data = await response.json();
      if (!(data.elements || []).some(e => e.type === 'way' && e.tags?.railway === 'rail')) {
        throw new Error('İZBAN route=train ilişkilerinden ray elemanı dönmedi.');
      }
      return data;
    } catch (error) {
      lastError = error;
      console.warn('İZBAN route ilişkisi kaynağı kullanılamadı:', error.message);
    }
  }
  throw lastError || new Error('İZBAN route ilişkileri alınamadı.');
}

function buildIzbanRelationGeometry(osm) {
  const ways = new Map();
  for (const element of osm.elements || []) {
    if (element.type !== 'way' || element.tags?.railway !== 'rail' || !Array.isArray(element.geometry)) continue;
    const service = String(element.tags?.service || '').toLowerCase();
    if (/yard|siding|spur|crossover|turntable|maintenance|depot|parking/.test(service)) continue;
    const coords = element.geometry
      .map(p => [Number(p.lon), Number(p.lat)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (coords.length < 2) continue;
    ways.set(String(element.id), coords);
  }

  if (!ways.size) throw new Error('İZBAN route=train ilişkilerinde ana ray geometrisi bulunamadı.');

  return {
    type: 'FeatureCollection',
    features: [...ways.entries()].map(([wayId, coordinates]) => ({
      type: 'Feature',
      properties: { name: 'İZBAN', source: 'OpenStreetMap İZBAN route=train relation', wayId },
      geometry: { type: 'LineString', coordinates }
    }))
  };
}

async function fetchOverpassRailGraph(stations) {
  const coords = stations.map(s => [Number(s.Enlem), Number(s.Boylam)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (coords.length < 2) throw new Error('İstasyon koordinatları bulunamadı.');
  const lats = coords.map(x => x[0]);
  const lons = coords.map(x => x[1]);
  const south = Math.min(...lats) - 0.03;
  const north = Math.max(...lats) + 0.03;
  const west = Math.min(...lons) - 0.03;
  const east = Math.max(...lons) + 0.03;
  const query = `[out:json][timeout:120];way["railway"="rail"]["service"!~"yard|siding|spur|crossover|turntable|maintenance|depot|parking"](${south},${west},${north},${east});out body geom;`;
  let lastError = null;
  for (const endpoint of OVERPASS_URLS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'izban-web/0.7' },
        body: new URLSearchParams({ data: query }).toString()
      });
      if (!response.ok) throw new Error(`${endpoint} -> ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      console.warn('Overpass uç noktası kullanılamadı:', error.message);
    }
  }
  throw lastError || new Error('Overpass erişilemedi.');
}

function pointKey(point) {
  return `${Number(point.lat).toFixed(7)},${Number(point.lon).toFixed(7)}`;
}

function buildRailGraph(osm) {
  const nodes = new Map();
  const graph = new Map();
  for (const way of (osm.elements || [])) {
    if (way.type !== 'way' || !Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const points = way.geometry
      .map(p => ({ lat: Number(p.lat), lon: Number(p.lon) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    for (const p of points) {
      const id = pointKey(p);
      nodes.set(id, p);
    }
    for (let i = 1; i < points.length; i += 1) {
      const a = pointKey(points[i - 1]);
      const b = pointKey(points[i]);
      if (a === b) continue;
      const weight = haversineMeters(points[i - 1], points[i]);
      if (!graph.has(a)) graph.set(a, []);
      if (!graph.has(b)) graph.set(b, []);
      graph.get(a).push({ to: b, weight });
      graph.get(b).push({ to: a, weight });
    }
  }
  return { nodes, graph };
}

function nearestGraphNode(nodes, station) {
  const target = { lat: Number(station.Enlem), lon: Number(station.Boylam) };
  let best = null;
  let bestDistance = Infinity;
  for (const [id, point] of nodes) {
    const distance = haversineMeters(target, point);
    if (distance < bestDistance) { bestDistance = distance; best = id; }
  }
  if (!best || bestDistance > 5000) throw new Error(`${station.IstasyonAdi} için ray üzerinde yakın nokta bulunamadı.`);
  return best;
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (a[p].d <= a[i].d) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    if (!a.length) return null;
    const root = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].d < a[m].d) m = l;
        if (r < a.length && a[r].d < a[m].d) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return root;
  }
  get length() { return this.items.length; }
}

function shortestRailPath(graphData, source, target) {
  const { graph } = graphData;
  const distances = new Map([[source, 0]]);
  const previous = new Map();
  const queue = new MinHeap();
  queue.push({ id: source, d: 0 });
  const visited = new Set();

  while (queue.length) {
    const current = queue.pop();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.id === target) break;
    for (const edge of (graph.get(current.id) || [])) {
      const next = current.d + edge.weight;
      if (next < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, next);
        previous.set(edge.to, current.id);
        queue.push({ id: edge.to, d: next });
      }
    }
  }

  if (!distances.has(target)) throw new Error('Ray ağı üzerinde iki istasyon arasında bağlantı bulunamadı.');
  const path = [];
  let cursor = target;
  while (cursor) {
    path.push(cursor);
    if (cursor === source) break;
    cursor = previous.get(cursor);
  }
  return path.reverse();
}

function buildOsmIzbanGeometry(osm, orderedStations) {
  const graphData = buildRailGraph(osm);
  if (graphData.nodes.size < 100) throw new Error('OpenStreetMap ray ağı beklenenden küçük.');
  const anchors = orderedStations.map(station => ({ station, node: nearestGraphNode(graphData.nodes, station) }));
  const coordinates = [];

  for (let i = 1; i < anchors.length; i += 1) {
    const path = shortestRailPath(graphData, anchors[i - 1].node, anchors[i].node);
    const segment = path.map(id => graphData.nodes.get(id)).filter(Boolean).map(p => [p.lon, p.lat]);
    if (!segment.length) continue;
    if (coordinates.length && coordinates[coordinates.length - 1][0] === segment[0][0] && coordinates[coordinates.length - 1][1] === segment[0][1]) {
      coordinates.push(...segment.slice(1));
    } else {
      coordinates.push(...segment);
    }
  }
  if (coordinates.length < 20) throw new Error('İZBAN ray güzergâhı yeterli geometri üretmedi.');

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: 'İZBAN', source: 'OpenStreetMap main railway track graph' },
      geometry: { type: 'LineString', coordinates }
    }]
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} zaman aşımına uğradı.`)), ms))
  ]);
}

async function getRouteGeometry() {
  const now = Date.now();
  if (routeGeometryCache && now - routeGeometryCacheAt < ROUTE_CACHE_TTL) return routeGeometryCache;

  const stations = await getStations();
  const orderedStations = [...stations]
    .filter(s => Number.isFinite(Number(s.IstasyonSirasi)))
    .sort((a, b) => Number(b.IstasyonSirasi) - Number(a.IstasyonSirasi));

  // Birincil kaynak: İZBAN'ın resmi GTFS shapes.txt. Bu veri araçların gerçek
  // ray/hat hizasını çok sayıda koordinatla tanımlar ve düz istasyon çizgisi değildir.
  try {
    const gtfs = await withTimeout(getGtfs(), 10000, 'İZBAN GTFS');
    const result = buildGtfsShapeGeometry(gtfs, orderedStations);
    routeGeometryCache = result;
    routeGeometryCacheAt = now;
    return result;
  } catch (gtfsError) {
    console.warn('İZBAN GTFS geometrisi kullanılamadı:', gtfsError.message);
  }

  // İkinci kaynak: yalnızca İZBAN route=train ilişkileri.
  try {
    const relationData = await withTimeout(fetchIzbanRouteRelations(orderedStations), 12000, 'İZBAN OpenStreetMap rota geometrisi');
    const result = buildIzbanRelationGeometry(relationData);
    routeGeometryCache = result;
    routeGeometryCacheAt = now;
    return result;
  } catch (relationError) {
    console.warn('İZBAN route relation geometrisi kullanılamadı:', relationError.message);
  }

  // Son OSM seçeneği: ray ağı üzerinde istasyonlar arasında gerçek rayları takip et.
  try {
    const osm = await withTimeout(fetchOverpassRailGraph(orderedStations), 12000, 'OpenStreetMap ray ağı');
    const result = buildOsmIzbanGeometry(osm, orderedStations);
    routeGeometryCache = result;
    routeGeometryCacheAt = now;
    return result;
  } catch (osmError) {
    console.warn('OSM ana ray geometrisi kullanılamadı:', osmError.message);
  }

  throw new Error('İZBAN gerçek güzergâh geometrisi alınamadı.');
}

function sendJson(res, status, data, cache = 'no-store') {
  res.writeHead(status, {
    'Content-Type': mime['.json'],
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function safeFile(filePath) {
  const normalized = path.normalize(filePath);
  return normalized.startsWith(ROOT) ? normalized : null;
}

function todayIzmir() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const date = normalizeDate(url.searchParams.get('date')) || todayIzmir();

    if (url.pathname === '/api/stations') {
      return sendJson(res, 200, await getStations(), 'public, max-age=21600');
    }

    if (url.pathname === '/api/route-geometry') {
      try {
        return sendJson(res, 200, await getRouteGeometry(), 'public, max-age=1800');
      } catch (error) {
        console.error('GTFS geometrisi alınamadı:', error.message);
        return sendJson(res, 502, { error: 'İZBAN gerçek güzergâh geometrisi alınamadı.', detail: error.message });
      }
    }

    if (url.pathname === '/api/schedule') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
        return sendJson(res, 400, { error: 'from ve to istasyon ID değerleri pozitif tam sayı olmalı.' });
      }
      if (from === to) return sendJson(res, 400, { error: 'Kalkış ve varış istasyonu aynı olamaz.' });

      try {
        const result = await getDateRouteSchedule(from, to, date);
        return sendJson(res, 200, { date, ...result }, 'private, max-age=300');
      } catch (error) {
        return sendJson(res, 502, { error: 'Sefer verisi alınamadı.', detail: error.message });
      }
    }

    if (url.pathname === '/api/station-departures') {
      const stationId = Number(url.searchParams.get('station'));
      if (!Number.isInteger(stationId) || stationId <= 0) {
        return sendJson(res, 400, { error: 'station pozitif tam sayı olmalı.' });
      }
      const data = await getStationDateDepartures(stationId, date);
      return sendJson(res, 200, { date, items: data, source: 'hybrid' }, 'private, max-age=300');
    }

    let requestPath = decodeURIComponent(url.pathname);
    if (requestPath === '/') requestPath = '/index.html';
    const filePath = safeFile(path.join(ROOT, requestPath));
    if (!filePath) return sendJson(res, 403, { error: 'Forbidden' });

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      }
      const contentType = mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 502, { error: 'İZBAN veri servisine erişilemedi.', detail: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`İZBAN web sitesi: http://localhost:${PORT}`);
});
