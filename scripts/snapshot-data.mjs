#!/usr/bin/env node
//
// Snapshot the live map + demand data into static files under data/, so a hosted
// deploy serves them from its own host instead of every first-time visitor hitting
// the Overpass and Socrata APIs live (slow to generate, rate limited). The app
// prefers these files if present and falls back to the live APIs if not — see
// loadSnapshot / SNAPSHOT_FILES in main.js.
//
//   node scripts/snapshot-data.mjs
//
// Overpass is a shared free service; if it's busy this may need a retry. The values
// below MUST match BBOX / TAXI_DATA / WATER_QUERY_SPAN in main.js — keep them in sync
// if you move the city or change the queries.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BBOX = { minLat: 40.700, maxLat: 40.762, minLon: -74.019, maxLon: -73.968 };
const CENTER_LAT = (BBOX.minLat + BBOX.maxLat) / 2;
const CENTER_LON = (BBOX.minLon + BBOX.maxLon) / 2;
const WATER_QUERY_SPAN = 2.6;

// Taxi demand sampling. The 2015 yellow-cab set (2yzn-sicd) is the last one with real
// pickup lat/lon — the 2023 feed only has taxi-zone IDs, which can't place a cab on a
// street. We sample one representative weekday and pull each hour *separately* so the
// map isn't dominated by one place or one time:
//   * A flat `$limit` with no `$order` returns an unstable, spatially-clustered slice
//     (Socrata gives no ordering guarantee) — that's what bunched every cab downtown.
//   * A single ordered query truncates to the first few hours: this bbox does ~5k
//     trips/hour, so 30k rows never reach past 09:00.
//   * Filtering by `date_extract_hh(...) = H` is a full scan (no index) and times out.
// So: one hour per query, sliced by an *indexed* `pickup_datetime BETWEEN` range (fast),
// with each hour's row count scaled to that hour's real volume so the demand curve — and
// the hour-of-day fleet scaling that reads it — stays intact.
const DEMAND_DAY = '2015-06-17';   // a normal Wednesday, no holiday skew
const DEMAND_TARGET = 24000;       // ~total rows, split across hours by real volume
const DEMAND_HOUR_MIN = 150;       // floor per hour, so quiet hours still seed the map
const DEMAND_HOUR_MAX = 1600;      // ceiling per hour, keeps each query fast + file lean
const SOCRATA_RESOURCE = 'https://data.cityofnewyork.us/resource/2yzn-sicd.json';

// 311 service requests — the "events" layer. Low volume in this bbox (~600/day), so one
// query for a representative recent weekday grabs the whole day with no truncation and
// therefore no sampling bias. Each row carries its own timestamp, so the app can reveal
// them by the hour on the time scrubber.
const EVENTS_DAY = '2024-06-12';   // a normal recent Wednesday
const EVENTS_LIMIT = 8000;         // a full bbox-day is ~600 rows; this never truncates
const EVENTS_RESOURCE = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';

// Collisions + crime: sparse point datasets, so aggregate a wide window by time of day
// (a single day is too thin to read). Both are geocoded Socrata sets like 311.
const COLLISIONS_RESOURCE = 'https://data.cityofnewyork.us/resource/h9gi-nx95.json';
const COLLISIONS_RANGE = ["2023-01-01T00:00:00", "2023-12-31T23:59:59"]; // one year
const CRIME_RESOURCE = 'https://data.cityofnewyork.us/resource/qgea-i56i.json';
const CRIME_RANGE = ["2023-06-01T00:00:00", "2023-06-30T23:59:59"];      // one month

// Citi Bike: not on Socrata — monthly CSV zips on S3 (100 MB–1 GB, several parts). We
// download the smallest recent month, stream every part through unzip, and keep one
// representative weekday's rides whose start is in the bbox.
const CITIBIKE_ZIP = 'https://s3.amazonaws.com/tripdata/202604-citibike-tripdata.zip';
const CITIBIKE_DAY = '2026-04-15';   // a normal Wednesday inside that month
const CITIBIKE_SAMPLE = 12000;       // trim to keep the file lean; the layer draws ~6k

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Overpass rejects requests without a User-Agent with HTTP 406 — and Node's fetch
// doesn't send one by default (that's the usual cause of the 406). Identify the tool
// per Overpass etiquette, and fall back across mirrors with a short retry.
const USER_AGENT = 'TaxiTaxi-3DCityMap snapshot (github.com/petermarkellis/3DCityMap)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function overpass(query) {
  let lastError;
  for (const endpoint of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        if (res.ok) return res.json();
        lastError = new Error(`${endpoint} → HTTP ${res.status}`);
        console.warn(`  ${lastError.message}${res.status === 429 || res.status === 504 ? ' (busy, retrying)' : ''}`);
      } catch (error) {
        lastError = error;
        console.warn(`  ${endpoint} → ${error.message}`);
      }
      await sleep(2000 * attempt); // brief backoff before retry / next mirror
    }
  }
  throw lastError ?? new Error('Overpass unavailable');
}

// Socrata throttles hard without an app token, and we fire ~25 requests here. Reuse the
// same public app token the app uses: env var first, else the git-ignored config.local.js
// (window.TAXI_APP_TOKEN = '…'). It's a read-only public token, so this is fine.
async function loadAppToken() {
  if (process.env.SOCRATA_APP_TOKEN) return process.env.SOCRATA_APP_TOKEN.trim();
  try {
    const text = await readFile('config.local.js', 'utf8');
    const match = text.match(/TAXI_APP_TOKEN\s*=\s*['"]([^'"]+)['"]/);
    if (match) return match[1];
  } catch { /* no local config — fall through to anonymous */ }
  return '';
}

async function socrata(url, appToken) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, appToken ? { headers: { 'X-App-Token': appToken } } : undefined);
      if (res.ok) return res.json();
      if (res.status !== 429 && res.status < 500) throw new Error(`Socrata HTTP ${res.status}`);
      lastError = new Error(`Socrata HTTP ${res.status}`);
      console.warn(`  ${lastError.message} (busy, retrying)`);
    } catch (error) {
      if (/HTTP \d/.test(error.message)) throw error; // a real 4xx, not worth retrying
      lastError = error; // network blip (ETIMEDOUT etc.) — back off and retry
      console.warn(`  Socrata ${error.message} (retrying)`);
    }
    await sleep(2000 * attempt);
  }
  throw lastError ?? new Error('Socrata unavailable after retries');
}

// Pull the demand sample: the hourly volume curve, then one indexed range query per hour
// with its row budget scaled to that curve. Returns an array of raw pickup rows in the
// same shape the live API gives, so the app's buildDemandModel needs no changes.
async function fetchTaxiDemand(appToken) {
  const bboxWhere = `pickup_latitude between ${BBOX.minLat} and ${BBOX.maxLat}`
    + ` and pickup_longitude between ${BBOX.minLon} and ${BBOX.maxLon}`;
  // dropoff_* rides along so the same file feeds both demand seeding (pickup) and the
  // origin→destination flow arcs (pickup→dropoff). Dropoffs can land off-map; the arc
  // layer filters those out.
  const select = 'pickup_longitude,pickup_latitude,pickup_datetime,dropoff_longitude,dropoff_latitude';

  // 1. Hourly curve for the representative day (a group-by aggregation is indexed/fast,
  //    unlike a date_extract filter). Gives count per hour → the shape of demand.
  const dayWhere = `${bboxWhere} and pickup_datetime between '${DEMAND_DAY}T00:00:00' and '${DEMAND_DAY}T23:59:59'`;
  const curveUrl = `${SOCRATA_RESOURCE}?$select=${encodeURIComponent('date_extract_hh(pickup_datetime) AS hour, count(*) AS n')}`
    + `&$where=${encodeURIComponent(dayWhere)}`
    + `&$group=${encodeURIComponent('date_extract_hh(pickup_datetime)')}&$limit=50`;
  const curve = await socrata(curveUrl, appToken);
  const hourCount = new Array(24).fill(0);
  for (const row of curve) {
    const h = parseInt(row.hour, 10);
    if (h >= 0 && h < 24) hourCount[h] = parseInt(row.n, 10) || 0;
  }
  const total = hourCount.reduce((a, b) => a + b, 0) || 1;

  // 2. One query per hour, budget scaled to real volume (clamped), sliced by an indexed
  //    datetime range so it's fast and the points spread citywide within the hour.
  const rows = [];
  for (let h = 0; h < 24; h += 1) {
    if (hourCount[h] === 0) continue;
    const budget = Math.min(DEMAND_HOUR_MAX,
      Math.max(DEMAND_HOUR_MIN, Math.round(DEMAND_TARGET * hourCount[h] / total)));
    const hh = String(h).padStart(2, '0');
    const hourWhere = `${bboxWhere} and pickup_datetime between '${DEMAND_DAY}T${hh}:00:00' and '${DEMAND_DAY}T${hh}:59:59'`;
    const url = `${SOCRATA_RESOURCE}?$select=${encodeURIComponent(select)}`
      + `&$where=${encodeURIComponent(hourWhere)}`
      + `&$order=${encodeURIComponent('pickup_datetime')}&$limit=${budget}`;
    const hourRows = await socrata(url, appToken);
    for (const r of hourRows) rows.push(r);
    process.stdout.write(`  hour ${hh}: ${hourRows.length}\r`);
  }
  console.log(`  sampled ${rows.length} pickups across 24 hours` + ' '.repeat(10));
  return rows;
}

// 311 complaints for one representative day, bbox-filtered. Returns raw rows
// {longitude, latitude, created_date, complaint_type}; the app buckets complaint_type
// into a handful of colour categories and reveals each point at its hour.
async function fetch311(appToken) {
  const where = `latitude between ${BBOX.minLat} and ${BBOX.maxLat}`
    + ` and longitude between ${BBOX.minLon} and ${BBOX.maxLon}`
    + ` and created_date between '${EVENTS_DAY}T00:00:00' and '${EVENTS_DAY}T23:59:59'`;
  const url = `${EVENTS_RESOURCE}?$select=${encodeURIComponent('longitude,latitude,created_date,complaint_type')}`
    + `&$where=${encodeURIComponent(where)}`
    + `&$order=${encodeURIComponent('created_date')}&$limit=${EVENTS_LIMIT}`;
  const rows = await socrata(url, appToken);
  // Some 311 rows geocode only to a zip — no point without a coordinate.
  return rows.filter((r) => r.longitude && r.latitude);
}

// Motor-vehicle collisions in the bbox over COLLISIONS_RANGE. Keeps coords + time +
// the injury/fatality counts the app turns into a severity category.
async function fetchCollisions(appToken) {
  const where = `latitude between ${BBOX.minLat} and ${BBOX.maxLat}`
    + ` and longitude between ${BBOX.minLon} and ${BBOX.maxLon}`
    + ` and crash_date between '${COLLISIONS_RANGE[0]}' and '${COLLISIONS_RANGE[1]}'`;
  const select = 'longitude,latitude,crash_time,number_of_persons_injured,number_of_persons_killed';
  const url = `${COLLISIONS_RESOURCE}?$select=${encodeURIComponent(select)}`
    + `&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent('crash_time')}&$limit=20000`;
  const rows = await socrata(url, appToken);
  return rows.filter((r) => r.longitude && r.latitude);
}

// NYPD crime complaints in the bbox over CRIME_RANGE. Keeps coords + time + the legal
// class the app colours by.
async function fetchCrime(appToken) {
  const where = `latitude between ${BBOX.minLat} and ${BBOX.maxLat}`
    + ` and longitude between ${BBOX.minLon} and ${BBOX.maxLon}`
    + ` and cmplnt_fr_dt between '${CRIME_RANGE[0]}' and '${CRIME_RANGE[1]}'`;
  const select = 'longitude,latitude,cmplnt_fr_tm,law_cat_cd';
  const url = `${CRIME_RESOURCE}?$select=${encodeURIComponent(select)}`
    + `&$where=${encodeURIComponent(where)}&$order=${encodeURIComponent('cmplnt_fr_tm')}&$limit=20000`;
  const rows = await socrata(url, appToken);
  return rows.filter((r) => r.longitude && r.latitude);
}

// Quote-aware split for one CSV line (station-name columns contain commas).
function csvSplit(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Stream one zip member (a CSV part) through `unzip -p` and keep matching rides.
function streamCitibikePart(zipPath, part, rows) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', zipPath, part]);
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line || line.startsWith('ride_id')) return; // header
      const f = csvSplit(line);
      const started = f[2];
      if (!started || started.slice(0, 10) !== CITIBIKE_DAY) return;
      const slat = +f[8], slng = +f[9], elat = +f[10], elng = +f[11];
      if (![slat, slng, elat, elng].every(Number.isFinite)) return;
      if (slat < BBOX.minLat || slat > BBOX.maxLat || slng < BBOX.minLon || slng > BBOX.maxLon) return;
      const hour = parseInt(started.slice(11, 13), 10);
      if (!(hour >= 0 && hour < 24)) return;
      rows.push({ start_lng: slng, start_lat: slat, end_lng: elng, end_lat: elat, hour });
    });
    rl.on('close', resolve);
    proc.on('error', reject);
  });
}

// Download the month zip, stream every CSV part, keep one weekday's bbox rides, and trim
// to a lean, hourly-representative sample (shuffle → slice).
async function fetchCitibike() {
  const zipPath = join(tmpdir(), 'citibike-snapshot.zip');
  console.log('  downloading month zip (this is the big one)…');
  const res = await fetch(CITIBIKE_ZIP);
  if (!res.ok) throw new Error(`Citi Bike zip HTTP ${res.status}`);
  await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));

  // List the CSV members and stream each.
  const parts = await new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-Z1', zipPath]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => resolve(out.split('\n').filter((n) => n.endsWith('.csv'))));
    proc.on('error', reject);
  });

  const rows = [];
  for (const part of parts) await streamCitibikePart(zipPath, part, rows);

  // Trim: shuffle then slice, so the kept rides stay spread across the day.
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, CITIBIKE_SAMPLE);
}

async function save(name, data) {
  const path = `data/${name}`;
  await writeFile(path, JSON.stringify(data));
  const mb = (JSON.stringify(data).length / 1e6).toFixed(1);
  console.log(`  wrote ${path} (${mb} MB)`);
}

async function main() {
  await mkdir('data', { recursive: true });

  const bbox = `${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon}`;
  console.log('Fetching OSM buildings + roads…');
  const osm = await overpass(`[out:json][timeout:90];(way["building"](${bbox});way["highway"](${bbox}););out body geom;`);
  console.log(`  ${osm.elements?.length ?? 0} elements`);
  await save('osm.json', osm);

  const hLat = ((BBOX.maxLat - BBOX.minLat) / 2) * WATER_QUERY_SPAN;
  const hLon = ((BBOX.maxLon - BBOX.minLon) / 2) * WATER_QUERY_SPAN;
  const wbbox = [CENTER_LAT - hLat, CENTER_LON - hLon, CENTER_LAT + hLat, CENTER_LON + hLon].join(',');
  console.log('Fetching water (coastline + polygons)…');
  const water = await overpass(`[out:json][timeout:90];(way["natural"="coastline"](${wbbox});way["natural"="water"](${wbbox});way["waterway"="riverbank"](${wbbox});relation["natural"="water"](${wbbox}););out body geom;`);
  console.log(`  ${water.elements?.length ?? 0} elements`);
  await save('water.json', water);

  console.log(`Fetching taxi demand (Socrata, ${DEMAND_DAY}, per-hour)…`);
  const appToken = await loadAppToken();
  if (!appToken) console.warn('  no app token (env SOCRATA_APP_TOKEN or config.local.js) — may be throttled');
  const demand = await fetchTaxiDemand(appToken);
  await save('taxi-demand.json', demand);

  console.log(`Fetching 311 events (Socrata, ${EVENTS_DAY})…`);
  const events = await fetch311(appToken);
  console.log(`  ${events.length} located complaints`);
  await save('events-311.json', events);

  console.log('Fetching collisions (Socrata, 2023, by time of day)…');
  const collisions = await fetchCollisions(appToken);
  console.log(`  ${collisions.length} located collisions`);
  await save('collisions.json', collisions);

  console.log('Fetching crime (Socrata, June 2023, by time of day)…');
  const crime = await fetchCrime(appToken);
  console.log(`  ${crime.length} located complaints`);
  await save('crime.json', crime);

  console.log(`Fetching Citi Bike (${CITIBIKE_DAY}, monthly CSV zip)…`);
  try {
    const citibike = await fetchCitibike();
    console.log(`  ${citibike.length} rides kept`);
    await save('citibike.json', citibike);
  } catch (error) {
    console.warn(`  Citi Bike skipped: ${error.message}`);
  }

  console.log('\nDone. Commit data/*.json (or host them) and the app will prefer them.');
}

main().catch((error) => {
  console.error('\nSnapshot failed:', error.message);
  process.exit(1);
});
