#!/usr/bin/env node
// Turns raw Overpass data (data/osm-raw.json, see fetch-osm.mjs) into the simulator's street
// network: src/data/lekki-network.json.
//
// - keeps drivable streets inside the pilot zone polygon (Lekki Phase 1)
// - projects lat/lon to metres (x east, y south) around the zone centre
// - classifies streets and marks the main corridors as bus streets by default
// - keeps the largest connected component
// - exports nearby streets outside the zone (for context), water, gates and POI hotspots
import { readFileSync, writeFileSync } from 'node:fs';

// Pilot zone: Lekki Phase 1, north of the Lekki-Epe Expressway up to the lagoon,
// from the Admiralty Way / Lekki toll gate curve in the west to Kusenla Road in the east.
// [lat, lon], clockwise. Edit this to change the pilot area.
export const ZONE = [
  [6.4372, 3.4455], [6.443, 3.4535], [6.447, 3.4575], [6.449, 3.4605], [6.452, 3.465],
  [6.46, 3.4695], [6.461, 3.48], [6.46, 3.493], [6.4345, 3.493], [6.4335, 3.487],
  [6.4318, 3.48], [6.43, 3.472], [6.429, 3.464], [6.431, 3.456], [6.4335, 3.4455],
];

// Places people travel to/from at the edge of the zone (connections to the rest of Lagos).
const GATES = [
  { name: 'Lekki Toll Gate', lat: 6.4361, lon: 3.4545 },
  { name: 'Lekki–Ikoyi Link Bridge', lat: 6.4478, lon: 3.4605 },
  { name: 'Oniru / Remi Olowude junction', lat: 6.4318, lon: 3.4688 },
  { name: 'Elegushi / Freedom Way junction', lat: 6.4338, lon: 3.4813 },
  { name: 'Ikate / Kusenla junction', lat: 6.4352, lon: 3.4906 },
];

const CLASS = {
  motorway: 'expressway', trunk: 'expressway', motorway_link: 'expressway', trunk_link: 'expressway',
  primary: 'arterial', primary_link: 'arterial', secondary: 'arterial', secondary_link: 'arterial',
  tertiary: 'collector', tertiary_link: 'collector',
  unclassified: 'local', residential: 'local', living_street: 'local',
};

export function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function buildNetwork(raw, zone = ZONE) {
  const lat0 = zone.reduce((s, p) => s + p[0], 0) / zone.length;
  const lon0 = zone.reduce((s, p) => s + p[1], 0) / zone.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  const proj = (lat, lon) => [Math.round((lon - lon0) * kx * 10) / 10, Math.round(-(lat - lat0) * ky * 10) / 10];
  const inZone = (lat, lon) => pointInPolygon(lat, lon, zone);

  const osmNodes = new Map();
  for (const e of raw.elements) if (e.type === 'node') osmNodes.set(e.id, e);

  // Context bbox: zone bbox padded by ~600 m.
  const lats = zone.map((p) => p[0]);
  const lons = zone.map((p) => p[1]);
  const pad = 0.0055;
  const ctx = [Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad];
  const inCtx = (lat, lon) => lat >= ctx[0] && lat <= ctx[2] && lon >= ctx[1] && lon <= ctx[3];

  // 1. Collect in-zone way pieces (split where a way leaves the zone).
  const pieces = [];
  const context = [];
  for (const e of raw.elements) {
    if (e.type !== 'way' || !e.tags?.highway) continue;
    const cls = CLASS[e.tags.highway];
    if (!cls) continue;
    if (e.tags.access === 'no') continue;
    let cur = [];
    const flush = () => {
      if (cur.length >= 2) pieces.push({ osmId: e.id, cls, name: e.tags.name || '', highway: e.tags.highway, ids: cur });
      cur = [];
    };
    let ctxCur = [];
    const ctxFlush = () => {
      if (ctxCur.length >= 2) context.push({ cls, pts: ctxCur });
      ctxCur = [];
    };
    for (const id of e.nodes) {
      const n = osmNodes.get(id);
      if (!n) { flush(); ctxFlush(); continue; }
      if (inZone(n.lat, n.lon)) {
        cur.push(id);
        if (ctxCur.length) { ctxCur.push(proj(n.lat, n.lon)); ctxFlush(); }
      } else {
        flush();
        if (inCtx(n.lat, n.lon)) ctxCur.push(proj(n.lat, n.lon));
        else ctxFlush();
      }
    }
    flush();
    ctxFlush();
  }

  // 2. Largest connected component over shared OSM nodes.
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  };
  for (const p of pieces) for (let i = 1; i < p.ids.length; i++) link(p.ids[i - 1], p.ids[i]);
  const comp = new Map();
  let best = -1;
  let bestSize = 0;
  let c = 0;
  for (const start of adj.keys()) {
    if (comp.has(start)) continue;
    const stack = [start];
    comp.set(start, c);
    let size = 0;
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const v of adj.get(u)) if (!comp.has(v)) { comp.set(v, c); stack.push(v); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }

  // 3. Emit nodes and ways. Only nodes used by kept ways; drop degree-2 nodes closer than
  //    ~4 m to their predecessor to keep the file small.
  const index = new Map();
  const nodes = [];
  const nodeOf = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      const n = osmNodes.get(id);
      i = nodes.length;
      nodes.push(proj(n.lat, n.lon));
      index.set(id, i);
    }
    return i;
  };
  const ways = [];
  for (const p of pieces) {
    if (comp.get(p.ids[0]) !== best) continue;
    const ids = p.ids.map(nodeOf);
    const bus = p.cls !== 'local';
    ways.push({ name: p.name, cls: p.cls, bus, nodes: ids });
  }

  // 4. Water (lines/polygons) clipped to the context bbox.
  const water = [];
  for (const e of raw.elements) {
    const t = e.tags || {};
    if (!(t.natural === 'water' || t.natural === 'coastline' || t.natural === 'wetland' || t.waterway)) continue;
    const lines = e.geometry ? [e.geometry] : (e.members || []).map((m) => m.geometry).filter(Boolean);
    for (const g of lines) {
      const pts = g.filter((p) => p && inCtx(p.lat, p.lon)).map((p) => proj(p.lat, p.lon));
      if (pts.length < 2) continue;
      const closed = e.type === 'way' && g[0] && g[g.length - 1] && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
      const kind = t.natural === 'water' && closed ? 'pond' : t.waterway ? 'stream' : 'shore';
      water.push({ kind, pts });
    }
  }

  // 5. POIs inside the zone, used to place demand hotspots.
  const pois = [];
  for (const e of raw.elements) {
    const t = e.tags;
    if (!t || t.highway === 'bus_stop' || t.natural || t.waterway || t.place || t.boundary) continue;
    if (t.highway && e.type === 'way') continue;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat === undefined || !inZone(lat, lon)) continue;
    const kind = t.shop ? 'shopping' : t.office ? 'office' : t.amenity === 'school' || t.amenity === 'college' || t.amenity === 'university' ? 'school'
      : t.amenity === 'hospital' || t.amenity === 'clinic' || t.amenity === 'pharmacy' ? 'health'
      : t.amenity === 'place_of_worship' ? 'worship'
      : t.amenity === 'restaurant' || t.amenity === 'cafe' || t.amenity === 'fast_food' ? 'food'
      : t.amenity === 'marketplace' ? 'shopping' : t.amenity || 'other';
    const [x, y] = proj(lat, lon);
    pois.push({ name: t.name || '', kind, x, y });
  }

  const xs = nodes.map((n) => n[0]);
  const ys = nodes.map((n) => n[1]);
  return {
    source: 'osm',
    attribution: '© OpenStreetMap contributors (ODbL)',
    fetchedAt: raw.fetchedAt,
    origin: { lat: lat0, lon: lon0 },
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    zone: zone.map(([la, lo]) => proj(la, lo)),
    nodes,
    ways,
    context,
    water,
    gates: GATES.map((g) => ({ name: g.name, ...Object.fromEntries(['x', 'y'].map((k, i) => [k, proj(g.lat, g.lon)[i]])) })),
    pois,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = JSON.parse(readFileSync(process.argv[2] || 'data/osm-raw.json', 'utf8'));
  const net = buildNetwork(raw);
  const out = process.argv[3] || 'src/data/lekki-network.json';
  writeFileSync(out, JSON.stringify(net));
  const len = (w) => w.nodes.slice(1).reduce((s, n, i) => s + Math.hypot(net.nodes[n][0] - net.nodes[w.nodes[i]][0], net.nodes[n][1] - net.nodes[w.nodes[i]][1]), 0);
  const km = (f) => (net.ways.filter(f).reduce((s, w) => s + len(w), 0) / 1000).toFixed(1);
  console.log(`Wrote ${out}: ${net.nodes.length} nodes, ${net.ways.length} ways (${km(() => true)} km, bus ${km((w) => w.bus)} km), ${net.pois.length} POIs, ${net.context.length} context lines, ${net.water.length} water lines.`);
}
