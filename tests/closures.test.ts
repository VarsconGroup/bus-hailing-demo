import { describe, expect, it } from 'vitest';
import raw from '../src/data/lekki-network.json';
import { DIVERTED_SPEED, type RawNetwork } from '../src/sim/network';
import { Simulation } from '../src/sim/simulation';

const lekki = raw as unknown as RawNetwork;

describe('Closing one side of a dual carriageway', () => {
  it('keeps buses off the closed side, sends them along the slowed other side, and restores it on reopening', () => {
    const sim = new Simulation(lekki, { fleetSize: 12 });
    sim.advance(1800);
    const net = sim.net;
    // Admiralty Way is mapped as two one-way carriageways.
    const side = net.ways.filter((w) => w.name === 'Admiralty Way').sort((a, b) => b.length - a.length)[0];
    const others = net.carriageways(side.id).filter((id) => id !== side.id);
    expect(others.length).toBeGreaterThan(0);

    sim.toggleClosed(side.id);
    expect(side.closed).toBe(true);
    for (const id of others) {
      expect(net.ways[id].closed).toBe(false);
      expect(net.ways[id].divert).toBe(DIVERTED_SPEED);
    }

    const onItAtClosure = new Set(sim.buses.filter((b) => b.edge >= 0 && net.eway[b.edge] === side.id).map((b) => b.id));
    let enteredClosed = 0;
    let usedOtherSide = 0;
    const last = sim.buses.map((b) => b.edge);
    for (let t = 0; t < 3600; t++) {
      sim.step();
      sim.buses.forEach((b, i) => {
        if (b.edge >= 0 && b.edge !== last[i]) {
          if (net.eway[b.edge] === side.id && !onItAtClosure.has(b.id)) enteredClosed++;
          if (others.includes(net.eway[b.edge])) usedOtherSide++;
        }
        last[i] = b.edge;
      });
    }
    expect(enteredClosed).toBe(0);
    expect(usedOtherSide).toBeGreaterThan(0);

    sim.toggleClosed(side.id);
    for (const id of others) expect(net.ways[id].divert).toBe(1);
  });

  it('does not treat a street’s end-to-end continuation as its other side', () => {
    const sim = new Simulation(lekki, {});
    const net = sim.net;
    const bisola = net.ways.filter((w) => w.name === 'Bisola Durotimi Etti Drive');
    for (const w of bisola) expect(net.carriageways(w.id)).toEqual([w.id]);
  });
});
