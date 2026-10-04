import { describe, expect, it } from 'vitest';
import raw from '../src/data/lekki-network.json';
import { summarize } from '../src/sim/economics';
import type { RawNetwork } from '../src/sim/network';
import { Simulation } from '../src/sim/simulation';
import { gridNetwork } from './helpers';

const lekki = raw as unknown as RawNetwork;

describe('Simulation', () => {
  it('accounts for every booking (grid town, full day)', () => {
    const sim = new Simulation(gridNetwork(8, 200, [0, 3, 7]), { fleetSize: 3, bookingsPerHour: 40, serviceStart: 7, serviceEnd: 11 });
    sim.runToEnd();
    const st = sim.stats;
    expect(sim.finished).toBe(true);
    expect(st.requested).toBeGreaterThan(50);
    const counts: Record<string, number> = {};
    for (const r of sim.riders) counts[r.state] = (counts[r.state] ?? 0) + 1;
    expect(counts.searching ?? 0).toBe(0);
    expect(counts.assigned ?? 0).toBe(0);
    expect(counts.onboard ?? 0).toBe(0);
    expect(counts.done ?? 0).toBe(st.served);
    expect(st.served).toBe(st.pickedUp);
    expect((counts.done ?? 0) + (counts.cancelled ?? 0) + (counts.rejected ?? 0) + (counts.noshow ?? 0)).toBe(st.requested);
    for (const b of sim.buses) {
      expect(b.onboard).toEqual([]);
      expect(b.stops).toEqual([]);
    }
    for (const r of sim.riders.filter((x) => x.state === 'done')) {
      expect(r.pickupTime).toBeGreaterThanOrEqual(r.readyTime - 1e-6);
      expect(r.dropoffTime).toBeGreaterThan(r.pickupTime);
    }
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const s = new Simulation(lekki, { fleetSize: 6, seed: 5 });
      s.advance(2 * 3600);
      return JSON.stringify([s.stats.requested, s.stats.pickedUp, s.stats.served, s.stats.km.toFixed(3)]);
    };
    expect(run()).toBe(run());
  });

  it('a bigger fleet serves more riders with shorter waits (Lekki, morning peak)', () => {
    const run = (fleetSize: number) => {
      const s = new Simulation(lekki, { fleetSize, seed: 3, bookingsPerHour: 150 });
      s.advance(3 * 3600);
      return summarize(s.cfg, s.stats, 3);
    };
    const small = run(3);
    const big = run(15);
    expect(big.requested).toBe(small.requested); // same demand stream
    expect(big.serviceRate).toBeGreaterThan(small.serviceRate);
    expect(big.avgWait).toBeLessThan(small.avgWait);
  });

  it('books a manual ride and carries it to the destination', () => {
    const sim = new Simulation(lekki, { fleetSize: 8 });
    sim.advance(600);
    const g = sim.net.gateNodes;
    const r = sim.book({ x: g[0].x + 150, y: g[0].y - 300, kind: 'home', label: 'Me' }, { x: g[3].x, y: g[3].y, kind: 'gate', label: g[3].name }, { manual: true });
    expect(r.state).toBe('assigned');
    expect(r.walkIn).toBeLessThanOrEqual(sim.cfg.maxWalk);
    for (let i = 0; i < 3600 && r.state !== 'done'; i++) sim.step();
    expect(r.state).toBe('done');
    expect(r.edgeTrip).toBe(true);
  });

  it('re-matches riders whose meetup point disappears when a street is closed', () => {
    const sim = new Simulation(lekki, { fleetSize: 6, seed: 9 });
    sim.advance(1800);
    const victim = sim.riders.find((r) => r.state === 'assigned');
    expect(victim).toBeDefined();
    const way = sim.net.wayAt(sim.net.x[victim!.pickupNode], sim.net.y[victim!.pickupNode], 3);
    sim.toggleClosed(way);
    expect(sim.net.isMeetup[victim!.pickupNode]).toBe(0);
    expect(['searching', 'assigned']).toContain(victim!.state);
    if (victim!.state === 'assigned') expect(sim.net.isMeetup[victim!.pickupNode]).toBe(1);
    sim.advance(3600);
    // the simulation keeps running consistently
    for (const b of sim.buses) for (const s of b.stops) expect(['assigned', 'onboard']).toContain(sim.riders[s.rider].state);
  });
});
