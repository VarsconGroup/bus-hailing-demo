// Dispatch: choose a meetup point and a bus for a booking, and where in that bus's stop list
// the pickup and drop-off go.
//
// This module is deliberately pure (no simulation state, no DOM), so the same rules can be
// ported to the production backend. See docs/dispatch-rules.md for the plain-English spec.

export type StopKind = 'pickup' | 'dropoff';
export interface Stop {
  node: number;
  kind: StopKind;
  rider: number;
}

/** What dispatch needs to know about a rider already on a bus's plan. */
export interface RiderInfo {
  id: number;
  requestTime: number;
  /** earliest time the rider can be at the pickup point (booking + walk) */
  readyTime: number;
  pickupNode: number;
  dropoffNode: number;
  /** direct bus time pickup → drop-off at booking time (s) */
  directTime: number;
  /** latest acceptable pickup time */
  latestPickup: number;
  /** set once the rider is on board */
  pickedUpAt?: number;
}

export interface BusState {
  id: number;
  /** node the bus will be at next (where a new plan can start) */
  startNode: number;
  /** time it gets there and is free to move on */
  startTime: number;
  onboard: number;
  capacity: number;
  stops: Stop[];
}

export interface DispatchParams {
  strategy: 'nearest' | 'pooling';
  maxDetour: number; // ride time ≤ maxDetour × direct + detourSlack
  detourSlack: number; // seconds
  stopDwell: number; // pull-over time when a bus stops at a new node
  boardTime: number; // per rider boarding / alighting
}

/** Travel time in seconds between two nodes under current traffic. */
export type TravelFn = (from: number, to: number) => number;

export interface Schedule {
  feasible: boolean;
  /** arrival-and-done time for each stop */
  times: number[];
  pickupAt: Map<number, number>;
  dropoffAt: Map<number, number>;
  endTime: number;
}

/** Walks a stop list from the bus's start, timing each stop and checking every constraint. */
export function simulateSchedule(
  bus: BusState,
  stops: Stop[],
  riders: Map<number, RiderInfo>,
  travel: TravelFn,
  p: DispatchParams,
  /** Constraints are relaxed to these times for riders already late in the current plan. */
  baseline?: Schedule,
): Schedule {
  let t = bus.startTime;
  let at = bus.startNode;
  let load = bus.onboard;
  const times: number[] = [];
  const pickupAt = new Map<number, number>();
  const dropoffAt = new Map<number, number>();
  let feasible = true;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const r = riders.get(s.rider)!;
    if (s.node !== at) {
      t += travel(at, s.node) + p.stopDwell;
      at = s.node;
    } else if (i === 0) {
      t += p.stopDwell;
    }
    if (s.kind === 'pickup') {
      t = Math.max(t, r.readyTime) + p.boardTime;
      pickupAt.set(r.id, t);
      load++;
      if (load > bus.capacity) feasible = false;
      const limit = Math.max(r.latestPickup, baseline?.pickupAt.get(r.id) ?? -Infinity);
      if (t > limit + 1e-6) feasible = false;
    } else {
      t += p.boardTime;
      dropoffAt.set(r.id, t);
      load--;
      const pickedUp = r.pickedUpAt ?? pickupAt.get(r.id) ?? t;
      const maxRide = p.maxDetour * r.directTime + p.detourSlack;
      const baseRide = baseline?.dropoffAt.has(r.id) ? baseline.dropoffAt.get(r.id)! - pickedUp : -Infinity;
      if (t - pickedUp > Math.max(maxRide, baseRide) + 1e-6) feasible = false;
    }
    if (!isFinite(t)) feasible = false;
    times.push(t);
  }
  return { feasible, times, pickupAt, dropoffAt, endTime: t };
}

export interface Insertion {
  busId: number;
  stops: Stop[];
  pickupNode: number;
  dropoffNode: number;
  pickupTime: number;
  dropoffTime: number;
  cost: number;
  /** extra delay this booking causes to riders already on the bus's plan (s) */
  addedDelay: number;
}

/**
 * Best way to add `rider` to `bus`: tries every pickup position i and drop-off position j ≥ i.
 * Returns null when no insertion satisfies capacity, the rider's latest pickup, and the
 * ride-time limits of everyone on the plan.
 */
export function bestInsertion(
  bus: BusState,
  rider: RiderInfo,
  riders: Map<number, RiderInfo>,
  travel: TravelFn,
  p: DispatchParams,
): Insertion | null {
  const all = new Map(riders);
  all.set(rider.id, rider);
  const base = simulateSchedule(bus, bus.stops, riders, travel, p);
  let best: Insertion | null = null;
  const n = bus.stops.length;
  const pick: Stop = { node: rider.pickupNode, kind: 'pickup', rider: rider.id };
  const drop: Stop = { node: rider.dropoffNode, kind: 'dropoff', rider: rider.id };
  // Seats taken just after each existing stop, for cheap pruning.
  const loadAfter: number[] = [];
  let load = bus.onboard;
  for (const st of bus.stops) loadAfter.push((load += st.kind === 'pickup' ? 1 : -1));
  for (let i = 0; i <= n; i++) {
    // Pickup inserted before stop i: is there a seat, and can the bus get there in time?
    if ((i === 0 ? bus.onboard : loadAfter[i - 1]) >= bus.capacity) continue;
    const prevNode = i === 0 ? bus.startNode : bus.stops[i - 1].node;
    const prevT = i === 0 ? bus.startTime : base.times[i - 1];
    const arrive = prevT + (prevNode === rider.pickupNode ? 0 : travel(prevNode, rider.pickupNode) + p.stopDwell);
    if (Math.max(arrive, rider.readyTime) + p.boardTime > rider.latestPickup) continue;
    for (let j = i; j <= n; j++) {
      // The new rider occupies a seat over stops i..j-1.
      if (j > i && loadAfter[j - 1] >= bus.capacity) break;
      const stops = [...bus.stops.slice(0, i), pick, ...bus.stops.slice(i, j), drop, ...bus.stops.slice(j)];
      const s = simulateSchedule(bus, stops, all, travel, p, base);
      if (!s.feasible) continue;
      let addedDelay = 0;
      for (const [id, t] of s.dropoffAt) if (id !== rider.id) addedDelay += t - (base.dropoffAt.get(id) ?? t);
      const pickupTime = s.pickupAt.get(rider.id)!;
      const dropoffTime = s.dropoffAt.get(rider.id)!;
      const cost =
        p.strategy === 'nearest'
          ? // The bus that gets to the rider first; tie-break on disruption to others.
            pickupTime + 0.01 * addedDelay
          : // Everyone's total time: the new rider's wait + ride, others' added delay, and a little bus time.
            pickupTime - rider.requestTime + (dropoffTime - pickupTime) + addedDelay + 0.2 * (s.endTime - base.endTime);
      if (!best || cost < best.cost) {
        best = { busId: bus.id, stops, pickupNode: rider.pickupNode, dropoffNode: rider.dropoffNode, pickupTime, dropoffTime, cost, addedDelay };
      }
    }
  }
  return best;
}

export interface MeetupOption {
  node: number;
  walk: number; // metres
}

export interface BookingRequest {
  id: number;
  requestTime: number;
  walkSpeed: number;
  /** candidate pickup points, nearest first */
  pickups: MeetupOption[];
  /** drop-off point (nearest meetup to the destination) */
  dropoff: MeetupOption;
  maxWait: number; // seconds after booking the bus must arrive by
  meetupStrategy: 'closest' | 'fastest';
}

export interface Assignment extends Insertion {
  walk: number;
  readyTime: number;
  directTime: number;
}

/**
 * Full booking decision: for each candidate meetup point (only the closest one under the
 * 'closest' strategy) and each candidate bus, find the best insertion and keep the cheapest.
 *
 * Buses are pre-filtered with a lower bound (straight to the pickup) and only the
 * `maxBuses` most promising are evaluated in full.
 */
export function assign(
  req: BookingRequest,
  buses: BusState[],
  riders: Map<number, RiderInfo>,
  travel: TravelFn,
  p: DispatchParams,
  maxBuses = 12,
): Assignment | null {
  const pickups = req.meetupStrategy === 'closest' ? req.pickups.slice(0, 1) : req.pickups.slice(0, 5);
  let best: Assignment | null = null;
  let bestScore = Infinity;
  for (const pu of pickups) {
    if (pu.node === req.dropoff.node) continue;
    const readyTime = req.requestTime + pu.walk / req.walkSpeed;
    const directTime = travel(pu.node, req.dropoff.node);
    if (!isFinite(directTime)) continue;
    const rider: RiderInfo = {
      id: req.id,
      requestTime: req.requestTime,
      readyTime,
      pickupNode: pu.node,
      dropoffNode: req.dropoff.node,
      directTime,
      latestPickup: req.requestTime + req.maxWait,
    };
    const latest = rider.latestPickup;
    const ranked = buses
      .map((b) => ({ b, lb: b.startTime + travel(b.startNode, pu.node) }))
      .filter((c) => c.lb <= latest)
      .sort((a, b) => a.lb - b.lb)
      .slice(0, maxBuses);
    for (const { b } of ranked) {
      const ins = bestInsertion(b, rider, riders, travel, p);
      if (!ins) continue;
      // Costs already include the walk (pickup can't happen before readyTime), so they are
      // comparable across meetup points.
      if (ins.cost < bestScore) {
        bestScore = ins.cost;
        best = { ...ins, walk: pu.walk, readyTime, directTime };
      }
    }
  }
  return best;
}
