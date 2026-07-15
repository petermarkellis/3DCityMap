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

import { writeFile, mkdir } from 'node:fs/promises';

const BBOX = { minLat: 40.700, maxLat: 40.762, minLon: -74.019, maxLon: -73.968 };
const CENTER_LAT = (BBOX.minLat + BBOX.maxLat) / 2;
const CENTER_LON = (BBOX.minLon + BBOX.maxLon) / 2;
const WATER_QUERY_SPAN = 2.6;
const DEMAND_LIMIT = 30000;

const OVERPASS = 'https://overpass-api.de/api/interpreter';

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status} — likely rate limited, retry shortly`);
  return res.json();
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

  console.log('Fetching taxi demand (Socrata)…');
  const where = `pickup_latitude between ${BBOX.minLat} and ${BBOX.maxLat}`
    + ` and pickup_longitude between ${BBOX.minLon} and ${BBOX.maxLon}`;
  const url = 'https://data.cityofnewyork.us/resource/2yzn-sicd.json'
    + '?$select=pickup_longitude,pickup_latitude,pickup_datetime'
    + `&$where=${encodeURIComponent(where)}&$limit=${DEMAND_LIMIT}`;
  const demandRes = await fetch(url);
  if (!demandRes.ok) throw new Error(`Socrata HTTP ${demandRes.status}`);
  const demand = await demandRes.json();
  console.log(`  ${demand.length} rows`);
  await save('taxi-demand.json', demand);

  console.log('\nDone. Commit data/*.json (or host them) and the app will prefer them.');
}

main().catch((error) => {
  console.error('\nSnapshot failed:', error.message);
  process.exit(1);
});
