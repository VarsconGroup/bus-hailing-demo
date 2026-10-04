import { describe, expect, it } from 'vitest';
import { assign, bestInsertion, simulateSchedule, type BusState, type DispatchParams, type RiderInfo } from '../src/sim/dispatch';

// Nodes are points on a line, 100 m apart; buses take 10 s per 100 m.
const travel = (a: number, b: number) => Math.abs(a - b) * 10;
const P: DispatchParams = { strategy: 'nearest', maxDetour: 1.5, detourSlack: 60, stopDwell: 0, boardTime: 0 };

function rider(id: number, pickupNode: number, dropoffNode: number, over: Partial<RiderInfo> = {}): RiderInfo {
  return {
    id, requestTime: 0, readyTime: 0, pickupNode, dropoffNode,
    directTime: travel(pickupNode, dropoffNode), latestPickup: 600, ...over,
  };
}
const bus = (id: number, startNode: number, over: Partial<BusState> = {}): BusState => ({ id, startNode, startTime: 0, onboard: 0, capacity: 14, stops: [], ...over });

describe('simulateSchedule', () => {
  it('waits for a rider who is still walking and adds dwell + boarding time', () => {
    const r = rider(1, 10, 20, { readyTime: 300 });
    const s = simulateSchedule(bus(0, 0), [{ node: 10, kind: 'pickup', rider: 1 }, { node: 20, kind: 'dropoff', rider: 1 }], new Map([[1, r]]), travel, { ...P, stopDwell: 20, boardTime: 5 });
    // drive 100 s + pull over 20 s, then wait for the rider until 300, board 5 s
    expect(s.pickupAt.get(1)).toBe(305);
    expect(s.dropoffAt.get(1)).toBe(305 + 100 + 20 + 5);
    expect(s.feasible).toBe(true);
  });

  it('flags capacity overflows', () => {
    const riders = new Map([[1, rider(1, 1, 5)], [2, rider(2, 2, 6)]]);
    const stops = [
      { node: 1, kind: 'pickup' as const, rider: 1 },
      { node: 2, kind: 'pickup' as const, rider: 2 },
      { node: 5, kind: 'dropoff' as const, rider: 1 },
      { node: 6, kind: 'dropoff' as const, rider: 2 },
    ];
    expect(simulateSchedule(bus(0, 0, { capacity: 2 }), stops, riders, travel, P).feasible).toBe(true);
    expect(simulateSchedule(bus(0, 0, { capacity: 1 }), stops, riders, travel, P).feasible).toBe(false);
  });
});

describe('bestInsertion', () => {
  it('pools a rider going the same way without breaking anyone’s detour limit', () => {
    const r1 = rider(1, 0, 30);
    const b = bus(0, 0, { onboard: 1, stops: [{ node: 30, kind: 'dropoff', rider: 1 }] });
    const r2 = rider(2, 10, 20);
    const ins = bestInsertion(b, r2, new Map([[1, { ...r1, pickedUpAt: 0 }]]), travel, P)!;
    expect(ins).not.toBeNull();
    expect(ins.stops.map((s) => `${s.kind}${s.rider}@${s.node}`)).toEqual(['pickup2@10', 'dropoff2@20', 'dropoff1@30']);
    expect(ins.addedDelay).toBe(0);
  });

  it('refuses when the only seat is taken', () => {
    const b = bus(0, 0, { onboard: 1, capacity: 1, stops: [{ node: 30, kind: 'dropoff', rider: 1 }] });
    const ins = bestInsertion(b, rider(2, 10, 20), new Map([[1, { ...rider(1, 0, 30), pickedUpAt: 0 }]]), travel, P);
    // Only feasible after rider 1 gets off at node 30.
    expect(ins?.stops[0]).toEqual({ node: 30, kind: 'dropoff', rider: 1 });
  });

  it('refuses pickups later than the rider’s latest pickup time', () => {
    const ins = bestInsertion(bus(0, 100), rider(2, 10, 20, { latestPickup: 500 }), new Map(), travel, P);
    expect(ins).toBeNull(); // 900 s away
  });

  it('refuses detours that make an on-board rider’s trip too long', () => {
    // Rider 1 rides 0→10 (100 s direct, limit 1.5×100+60 = 210 s). Detouring to 25 and back is too far.
    const b = bus(0, 0, { onboard: 1, stops: [{ node: 10, kind: 'dropoff', rider: 1 }] });
    const ins = bestInsertion(b, rider(2, 25, 30), new Map([[1, { ...rider(1, 0, 10), pickedUpAt: 0 }]]), travel, P)!;
    expect(ins.stops[0]).toEqual({ node: 10, kind: 'dropoff', rider: 1 });
  });
});

describe('assign', () => {
  const req = (pickups: { node: number; walk: number }[], over = {}) => ({
    id: 9, requestTime: 0, walkSpeed: 1, pickups, dropoff: { node: 50, walk: 0 }, maxWait: 900, meetupStrategy: 'closest' as const, ...over,
  });

  it('nearest strategy picks the bus that reaches the meetup point first', () => {
    const buses = [bus(0, 0), bus(1, 38), bus(2, 45)];
    const a = assign(req([{ node: 40, walk: 0 }]), buses, new Map(), travel, P)!;
    expect(a.busId).toBe(1);
    expect(a.pickupTime).toBe(20);
  });

  it('skips full buses', () => {
    const r1 = { ...rider(1, 0, 60), pickedUpAt: 0 };
    const buses = [bus(0, 39, { onboard: 1, capacity: 1, stops: [{ node: 60, kind: 'dropoff', rider: 1 }] }), bus(1, 20)];
    const a = assign(req([{ node: 40, walk: 0 }]), buses, new Map([[1, r1]]), travel, P)!;
    expect(a.busId).toBe(1);
  });

  it('closest strategy uses the nearest meetup point; fastest may choose a farther one', () => {
    const buses = [bus(0, 0)];
    const pickups = [{ node: 40, walk: 50 }, { node: 30, walk: 120 }];
    expect(assign(req(pickups), buses, new Map(), travel, P)!.pickupNode).toBe(40);
    // Walking 120 m (120 s) to node 30 beats waiting for the bus to drive to 40 (400 s).
    expect(assign(req(pickups, { meetupStrategy: 'fastest' }), buses, new Map(), travel, P)!.pickupNode).toBe(30);
  });

  it('returns null when no bus can make it in time', () => {
    expect(assign(req([{ node: 40, walk: 0 }], { maxWait: 100 }), [bus(0, 0)], new Map(), travel, P)).toBeNull();
  });
});
