import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS build script
import { buildNetwork, pointInPolygon } from '../scripts/build-network.mjs';

// A tiny Overpass-format response: a square zone with a primary road, a residential street,
// a stray street outside the zone and a disconnected fragment.
const zone = [[6.44, 3.46], [6.44, 3.47], [6.45, 3.47], [6.45, 3.46]];
const node = (id: number, lat: number, lon: number) => ({ type: 'node', id, lat, lon });
const raw = {
  fetchedAt: 'test',
  elements: [
    node(1, 6.445, 3.461), node(2, 6.445, 3.465), node(3, 6.445, 3.469), // main road
    node(4, 6.448, 3.465), // residential off node 2
    node(5, 6.46, 3.465), // outside the zone
    node(6, 6.442, 3.462), node(7, 6.442, 3.463), // fragment
    { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'primary', name: 'Admiralty Way' } },
    { type: 'way', id: 11, nodes: [2, 4, 5], tags: { highway: 'residential', name: 'Close A' } },
    { type: 'way', id: 12, nodes: [6, 7], tags: { highway: 'residential' } },
    { type: 'way', id: 13, nodes: [1, 3], tags: { highway: 'footway' } },
    { type: 'node', id: 20, lat: 6.446, lon: 3.464, tags: { shop: 'mall', name: 'Mall' } },
    { type: 'way', id: 30, tags: { natural: 'coastline' }, geometry: [{ lat: 6.449, lon: 3.46 }, { lat: 6.449, lon: 3.47 }] },
  ],
};

describe('build-network', () => {
  it('pointInPolygon', () => {
    expect(pointInPolygon(6.445, 3.465, zone)).toBe(true);
    expect(pointInPolygon(6.46, 3.465, zone)).toBe(false);
  });

  it('clips to the zone, classifies streets and keeps the largest component', () => {
    const net = buildNetwork(raw, zone);
    const names = net.ways.map((w: { name: string }) => w.name).sort();
    expect(names).toEqual(['Admiralty Way', 'Close A']);
    const main = net.ways.find((w: { name: string }) => w.name === 'Admiralty Way');
    expect(main.cls).toBe('arterial');
    expect(main.bus).toBe(true);
    const close = net.ways.find((w: { name: string }) => w.name === 'Close A');
    expect(close.cls).toBe('local');
    expect(close.bus).toBe(false);
    expect(close.nodes.length).toBe(2); // node 5 is outside the zone
    expect(net.nodes.length).toBe(4);
    // ~888 m between nodes 1 and 3 along the latitude line
    const [a, , c] = main.nodes.map((i: number) => net.nodes[i]);
    expect(Math.hypot(c[0] - a[0], c[1] - a[1])).toBeGreaterThan(850);
    expect(Math.hypot(c[0] - a[0], c[1] - a[1])).toBeLessThan(900);
    expect(net.pois).toHaveLength(1);
    expect(net.water).toHaveLength(1);
    expect(net.gates.length).toBeGreaterThan(0);
  });
});
