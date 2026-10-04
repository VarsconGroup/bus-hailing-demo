import { describe, expect, it } from 'vitest';
import raw from '../src/data/lekki-network.json';
import { CLASS_SPEED, Network, WALK_DETOUR, type RawNetwork } from '../src/sim/network';
import { gridNetwork } from './helpers';

describe('Network', () => {
  it('subdivides bus streets into short segments but leaves local streets alone', () => {
    const net = new Network(gridNetwork(), 200);
    for (let e = 0; e < net.ea.length; e++) {
      const w = net.ways[net.eway[e]];
      if (w.cls === 'local') expect(net.elen[e]).toBeCloseTo(200);
      else expect(net.elen[e]).toBeLessThanOrEqual(40 + 1e-6);
    }
  });

  it('places meetup points only on bus streets, at least `spacing` apart (gates excepted)', () => {
    for (const spacing of [100, 200, 350]) {
      const net = new Network(gridNetwork(), spacing);
      const gates = new Set(net.gateNodes.map((g) => g.node));
      const ms = net.meetups;
      expect(ms.length).toBeGreaterThan(3);
      for (const m of ms) expect(net.adj[m].some((e) => net.isBusEdge(e))).toBe(true);
      for (let i = 0; i < ms.length; i++)
        for (let j = i + 1; j < ms.length; j++) {
          if (gates.has(ms[i]) || gates.has(ms[j])) continue;
          expect(Math.hypot(net.x[ms[i]] - net.x[ms[j]], net.y[ms[i]] - net.y[ms[j]])).toBeGreaterThanOrEqual(spacing - 1e-6);
        }
    }
  });

  it('finds the fastest bus route and its travel time', () => {
    const net = new Network(gridNetwork(), 200);
    const a = net.nearestNode(0, 0);
    const b = net.nearestNode(1000, 1000);
    // Along row 0 then column 5, all collector streets: 2000 m.
    expect(net.time(a, b)).toBeCloseTo(2000 / CLASS_SPEED.collector, 0);
    expect(net.pathLength(a, b)).toBeCloseTo(2000, 0);
    const p = net.path(a, b);
    expect(p[p.length - 1]).toBe(b);
    for (let i = 1; i < p.length; i++) expect(net.edgeBetween(p[i - 1], p[i])).toBeGreaterThanOrEqual(0);
  });

  it('routes around a closed street and avoids non-bus streets', () => {
    const net = new Network(gridNetwork(), 200);
    const a = net.nearestNode(0, 0);
    const b = net.nearestNode(1000, 0);
    const before = net.time(a, b);
    net.toggleClosed(net.ways.findIndex((w) => w.name === 'Row 0'));
    const after = net.time(a, b);
    expect(after).toBeGreaterThan(before);
    // Detour must use bus streets only (col 0 → row 2 → col 5), not local rows.
    const path = net.path(a, b);
    for (let i = 1; i < path.length; i++) expect(net.isBusEdge(net.edgeBetween(path[i - 1], path[i]))).toBe(true);
  });

  it('adds and removes meetup points when a street is opened to or banned for buses', () => {
    const net = new Network(gridNetwork(), 200);
    const before = net.meetups.length;
    const row3 = net.ways.findIndex((w) => w.name === 'Row 3');
    net.toggleBus(row3);
    expect(net.meetups.length).toBeGreaterThan(before);
    net.toggleBus(row3);
    expect(net.meetups.length).toBe(before);
  });

  it('meetupsNear matches a brute-force search on the real Lekki network', () => {
    const net = new Network(raw as unknown as RawNetwork, 200);
    for (const [x, y, walk] of [[0, 0, 500], [-1200, 300, 400], [900, -700, 800], [2000, 1000, 5000]]) {
      const got = net.meetupsNear(x, y, walk, 3).map((m) => m.node);
      const want = net.meetups
        .map((m) => ({ m, d: Math.hypot(net.x[m] - x, net.y[m] - y) * WALK_DETOUR }))
        .filter((o) => o.d <= walk)
        .sort((p, q) => p.d - q.d)
        .slice(0, 3)
        .map((o) => o.m);
      expect(got).toEqual(want);
    }
  });

  it('builds a single connected bus network for Lekki Phase 1 with gates as meetup points', () => {
    const net = new Network(raw as unknown as RawNetwork, 200);
    expect(net.mainComp).toBeGreaterThanOrEqual(0);
    expect(net.gateNodes.length).toBe(5);
    for (const g of net.gateNodes) expect(net.isMeetup[g.node]).toBe(1);
    expect(net.meetups.length).toBeGreaterThan(50);
    const s = net.stats();
    expect(s.busKm).toBeGreaterThan(30);
  });
});
