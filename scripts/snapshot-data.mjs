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
  const select = 'pickup_longitude,pickup_latitude,pickup_datetime';

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

  console.log('\nDone. Commit data/*.json (or host them) and the app will prefer them.');
}

main().catch((error) => {
  console.error('\nSnapshot failed:', error.message);
  process.exit(1);
});
