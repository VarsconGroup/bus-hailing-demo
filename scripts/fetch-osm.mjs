#!/usr/bin/env node
// Downloads raw OpenStreetMap data for Lekki Phase 1 from the Overpass API and saves it to
// data/osm-raw.json. Run `npm run build-network` afterwards to turn it into the simulator's
// street network (src/data/lekki-osm.json).
//
// Usage: node scripts/fetch-osm.mjs [south west north east]
import { writeFileSync, mkdirSync } from 'node:fs';

const [s, w, n, e] = process.argv.slice(2).map(Number);
// Generous box around Lekki Phase 1 (lagoon to the north, expressway to the south).
const bbox = Number.isFinite(e) ? [s, w, n, e] : [6.42, 3.44, 6.47, 3.51];
const b = bbox.join(',');

const query = `
[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${b});
)->.roads;
.roads out body;
.roads >;
out skel qt;
(
  way["natural"="coastline"](${b});
  nwr["natural"="water"](${b});
  nwr["natural"="wetland"](${b});
  way["waterway"](${b});
)->.water;
.water out geom(${b});
(
  nwr["amenity"~"^(school|college|university|bank|restaurant|cafe|fast_food|hospital|clinic|pharmacy|place_of_worship|marketplace|fuel|bus_station)$"](${b});
  nwr["shop"~"^(mall|supermarket|department_store)$"](${b});
  nwr["office"](${b});
  nwr["highway"="bus_stop"](${b});
  nwr["barrier"="toll_booth"](${b});
)->.pois;
.pois out center tags;
(
  nwr["place"~"^(suburb|neighbourhood|quarter)$"](${b});
  relation["boundary"="administrative"]["name"~"Lekki|Eti-Osa",i](${b});
)->.places;
.places out center tags;
`;

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

let lastErr;
for (const url of endpoints) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`Querying ${url} (attempt ${attempt + 1}) for bbox ${b}…`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bus-hailing-demo/0.1 (pilot simulation)' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      json.bbox = bbox;
      json.fetchedAt = new Date().toISOString();
      mkdirSync('data', { recursive: true });
      writeFileSync('data/osm-raw.json', JSON.stringify(json));
      console.log(`Saved data/osm-raw.json with ${json.elements.length} elements.`);
      process.exit(0);
    } catch (err) {
      lastErr = err;
      console.warn(`  failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}
console.error('All Overpass endpoints failed:', lastErr);
process.exit(1);
