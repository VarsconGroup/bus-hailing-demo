import { describe, expect, it } from 'vitest';
import raw from '../src/data/lekki-network.json';
import { evCount } from '../src/sim/config';
import { summarize } from '../src/sim/economics';
import type { RawNetwork } from '../src/sim/network';
import { Simulation } from '../src/sim/simulation';

const lekki = raw as unknown as RawNetwork;

describe('Electric buses', () => {
  it('counts electric buses for each fleet type', () => {
    expect(evCount({ powertrain: 'ev', evShare: 0.5, fleetSize: 9 })).toBe(9);
    expect(evCount({ powertrain: 'fuel', evShare: 0.5, fleetSize: 9 })).toBe(0);
    expect(evCount({ powertrain: 'mixed', evShare: 0.3, fleetSize: 10 })).toBe(3);
    const sim = new Simulation(lekki, { powertrain: 'mixed', evShare: 0.5, fleetSize: 6 });
    expect(sim.buses.filter((b) => b.ev)).toHaveLength(3);
  });

  it('sends low buses to the hub, never exceeds the chargers, and keeps batteries above zero', () => {
    // Small batteries force several charging cycles in a few hours.
    const sim = new Simulation(lekki, { powertrain: 'ev', fleetSize: 6, batteryKWh: 12, chargeAtPct: 0.3, chargers: 2, chargerKW: 30 });
    let maxInUse = 0;
    let sawQueue = false;
    for (let t = 0; t < 5 * 3600; t++) {
      sim.step();
      maxInUse = Math.max(maxInUse, sim.chargersInUse);
      if (sim.buses.some((b) => b.charge === 'queued')) sawQueue = true;
      for (const b of sim.buses) {
        if (b.charge === 'charging' || b.charge === 'queued') expect(b.node).toBe(sim.hubNode);
      }
    }
    expect(maxInUse).toBeLessThanOrEqual(2);
    expect(maxInUse).toBe(2);
    expect(sawQueue).toBe(true);
    expect(sim.stats.chargeVisits).toBeGreaterThan(3);
    expect(sim.stats.flatBatteries).toBe(0);
    for (const b of sim.buses) expect(b.soc).toBeGreaterThan(0);
  });

  it('never hands a new booking to a bus that needs charging', () => {
    const sim = new Simulation(lekki, { powertrain: 'ev', fleetSize: 5, batteryKWh: 10, chargeAtPct: 0.4 });
    const before = new Map<number, number>();
    for (let t = 0; t < 3 * 3600; t++) {
      for (const b of sim.buses) before.set(b.id, b.stops.filter((s) => s.kind === 'pickup').length);
      const wasCharging = sim.buses.map((b) => b.charge !== 'none');
      sim.step();
      sim.buses.forEach((b, i) => {
        if (wasCharging[i] && b.charge !== 'none') {
          // pickups can only go down while the bus is out of service for charging
          expect(b.stops.filter((s) => s.kind === 'pickup').length).toBeLessThanOrEqual(before.get(b.id)!);
        }
      });
    }
  });

  it('charges electric fleets for electricity and petrol fleets for fuel', () => {
    const run = (powertrain: 'ev' | 'fuel') => {
      const s = new Simulation(lekki, { powertrain, fleetSize: 6, seed: 4 });
      s.advance(3 * 3600);
      return summarize(s.cfg, s.stats, 3);
    };
    const ev = run('ev');
    const fuel = run('fuel');
    expect(ev.fuelCost).toBe(0);
    expect(ev.electricityCost).toBeGreaterThan(0);
    expect(fuel.electricityCost).toBe(0);
    expect(fuel.fuelCost).toBeGreaterThan(0);
    expect(ev.co2PerRide).toBeLessThan(fuel.co2PerRide);
    expect(ev.requested).toBe(fuel.requested); // same demand either way
  });

  it('moving the hub snaps it to a meetup point', () => {
    const sim = new Simulation(lekki, {});
    const g = sim.net.gateNodes[0];
    sim.setHub(g.x + 20, g.y + 20);
    expect(sim.net.isMeetup[sim.hubNode]).toBe(1);
    expect(Math.hypot(sim.net.x[sim.hubNode] - g.x, sim.net.y[sim.hubNode] - g.y)).toBeLessThan(250);
  });
});
