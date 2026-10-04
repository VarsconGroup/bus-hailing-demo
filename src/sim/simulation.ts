// The simulated day. Pure TypeScript (no DOM) so it runs in the page, in a Web Worker for
// scenario sweeps, and in tests.
import { DEFAULT_CONFIG, type SimConfig } from './config';
import { Demand, peakness, type Place } from './demand';
import { assign, type BusState, type DispatchParams, type RiderInfo, type Stop } from './dispatch';
import { fareFor } from './economics';
import { Network, type RawNetwork } from './network';
import { Rng } from './rng';

export type RiderState = 'searching' | 'assigned' | 'onboard' | 'done' | 'cancelled' | 'rejected' | 'noshow';

export interface Rider {
  id: number;
  state: RiderState;
  from: Place;
  to: Place;
  edgeTrip: boolean;
  manual: boolean;
  noShow: boolean;
  requestTime: number;
  pickupNode: number;
  dropoffNode: number;
  walkIn: number;
  walkOut: number;
  readyTime: number;
  directTime: number;
  directDist: number;
  latestPickup: number;
  promisedPickup: number;
  promisedDropoff: number;
  busId: number;
  pickupTime: number;
  dropoffTime: number;
  fare: number;
  nextRetry: number;
  reason: string;
}

export type BusStatus = 'idle' | 'toPickup' | 'carrying' | 'offDuty';

export interface Bus {
  id: number;
  node: number; // last node reached (or current node when edge < 0)
  edge: number; // edge being driven, -1 when at a node
  to: number; // node at the end of `edge`
  pos: number; // metres travelled along `edge`
  path: number[];
  pathTarget: number;
  pathVersion: number;
  stops: Stop[];
  onboard: number[];
  dwellUntil: number;
  graceUntil: number;
  fresh: boolean; // just arrived at the node (pull-over time not yet charged)
  idleTarget: number;
  idleChecked: number;
  // odometers & timers
  km: number;
  kmLoaded: number;
  paxKm: number;
  serviceSec: number;
  busySec: number;
  trips: number;
}

export interface LogEvent {
  t: number;
  kind: 'book' | 'assign' | 'pickup' | 'dropoff' | 'noshow' | 'cancel' | 'reject' | 'network' | 'info';
  text: string;
  rider?: number;
  bus?: number;
}

export interface Sample {
  t: number;
  waiting: number;
  riding: number;
  busesCarrying: number;
  busesToPickup: number;
  busesIdle: number;
  avgWait: number; // minutes, pickups in the last 30 min
  bookings: number; // cumulative
  served: number; // cumulative
}

export interface Stats {
  requested: number;
  pickedUp: number;
  served: number;
  cancelled: number;
  rejectedWalk: number;
  rejectedNoBus: number;
  noShows: number;
  waits: number[];
  walks: number[];
  rides: number[];
  detours: number[];
  lateness: number[];
  revenue: number;
  km: number;
  kmLoaded: number;
  paxKm: number;
  seatKm: number;
  busHours: number;
  busyHours: number;
}

const RETRY_SEC = 30;
const CANCEL_GRACE_SEC = 300; // assigned riders cancel this long after their latest pickup time
const SAMPLE_SEC = 60;

export class Simulation {
  cfg: SimConfig;
  readonly net: Network;
  readonly demand: Demand;
  now: number;
  riders: Rider[] = [];
  buses: Bus[] = [];
  log: LogEvent[] = [];
  series: Sample[] = [];
  stats: Stats;
  private active = new Set<number>();
  private demandRng: Rng;
  private opsRng: Rng;
  private nextArrival = Infinity;
  private nextSample = 0;
  private recent: { t: number; x: number; y: number }[] = [];
  onEvent?: (e: LogEvent) => void;

  constructor(raw: RawNetwork, cfg: Partial<SimConfig> = {}, net?: Network) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.net = net ?? new Network(raw, this.cfg.meetupSpacing);
    this.net.setMeetupSpacing(this.cfg.meetupSpacing);
    this.demand = new Demand(this.net, this.cfg.serviceStart, this.cfg.serviceEnd);
    this.now = this.cfg.serviceStart * 3600;
    this.nextSample = this.now;
    // Separate random streams so changing the fleet doesn't change who books when.
    this.demandRng = new Rng(this.cfg.seed * 7919 + 1);
    this.opsRng = new Rng(this.cfg.seed * 104729 + 2);
    this.stats = emptyStats();
    const starts = [...this.net.meetups];
    for (let i = 0; i < this.cfg.fleetSize; i++) {
      const node = starts.length ? starts.splice(this.opsRng.int(starts.length), 1)[0] : 0;
      this.buses.push(newBus(i, node));
    }
    this.scheduleArrival();
  }

  get hour() {
    return this.now / 3600;
  }
  get inService() {
    return this.hour >= this.cfg.serviceStart && this.hour < this.cfg.serviceEnd;
  }
  /** Everything finished: service over, no riders left in the system. */
  get finished() {
    return !this.inService && this.hour >= this.cfg.serviceEnd && this.active.size === 0;
  }

  /** Global speed factor (1 = free flow). */
  traffic(): number {
    const base = this.cfg.trafficLevel;
    return this.cfg.timeVaryingTraffic ? base * (1 - 0.45 * peakness(this.hour % 24)) : base;
  }

  /** Current bookings per hour. */
  demandRate(): number {
    if (!this.inService) return 0;
    return this.cfg.bookingsPerHour * (this.cfg.useDemandProfile ? this.demand.profile(this.hour) : 1);
  }

  setConfig(patch: Partial<SimConfig>) {
    const prev = this.cfg;
    this.cfg = { ...this.cfg, ...patch };
    if (patch.meetupSpacing !== undefined && patch.meetupSpacing !== prev.meetupSpacing) {
      this.net.setMeetupSpacing(this.cfg.meetupSpacing);
      this.networkChanged('Meetup points re-spaced');
    }
    if (patch.serviceEnd !== undefined) this.demand.setServiceWindow(this.cfg.serviceStart, this.cfg.serviceEnd);
    this.scheduleArrival();
  }

  private scheduleArrival() {
    const rate = this.demandRate() / 3600;
    this.nextArrival = rate > 0 ? this.now + this.demandRng.exp(rate) : Infinity;
  }

  private emit(e: Omit<LogEvent, 't'>) {
    const ev = { t: this.now, ...e };
    this.log.push(ev);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 300);
    this.onEvent?.(ev);
  }

  /** Advance the simulation by `seconds` in 1-second steps. */
  advance(seconds: number) {
    for (let i = 0; i < seconds; i++) this.step();
  }

  step(dt = 1) {
    this.now += dt;
    // New bookings (Poisson; rate re-evaluated after each one so the daily profile is followed).
    if (this.nextArrival === Infinity && this.inService) this.scheduleArrival();
    while (this.nextArrival <= this.now) {
      if (!this.inService) {
        this.nextArrival = Infinity;
        break;
      }
      const h = this.hour;
      const trip = this.demand.trip(this.demandRng, h, this.cfg.edgeTripShare, this.cfg.hotspotShare);
      const noShow = this.demandRng.next() < this.cfg.noShowRate;
      this.book(trip.from, trip.to, { noShow });
      this.scheduleArrival();
    }

    // Riders still searching retry; riders left waiting too long give up.
    for (const id of this.active) {
      const r = this.riders[id];
      if (r.state === 'searching' && this.now >= r.nextRetry) {
        if (this.now > r.latestPickup) this.reject(r, 'No bus could reach them in time');
        else this.tryAssign(r);
      } else if (r.state === 'assigned' && this.now > r.latestPickup + CANCEL_GRACE_SEC && !r.manual) {
        this.cancel(r, 'Bus too late — rider cancelled');
      }
    }

    const traffic = this.traffic();
    for (const b of this.buses) this.moveBus(b, dt, traffic);

    if (this.now >= this.nextSample) {
      this.sample();
      this.nextSample += SAMPLE_SEC;
    }
  }

  // ---------------------------------------------------------------- bookings

  /** Create a booking from `from` to `to`. Returns the rider (check `state`). */
  book(from: Place, to: Place, opts: { noShow?: boolean; manual?: boolean } = {}): Rider {
    const r: Rider = {
      id: this.riders.length,
      state: 'searching',
      from,
      to,
      edgeTrip: from.kind === 'gate' || to.kind === 'gate',
      manual: !!opts.manual,
      noShow: !!opts.noShow && !opts.manual,
      requestTime: this.now,
      pickupNode: -1,
      dropoffNode: -1,
      walkIn: 0,
      walkOut: 0,
      readyTime: this.now,
      directTime: 0,
      directDist: 0,
      latestPickup: this.now + this.cfg.maxWaitMin * 60,
      promisedPickup: 0,
      promisedDropoff: 0,
      busId: -1,
      pickupTime: -1,
      dropoffTime: -1,
      fare: 0,
      nextRetry: this.now,
      reason: '',
    };
    this.riders.push(r);
    this.stats.requested++;
    this.recent.push({ t: this.now, x: from.x, y: from.y });
    if (this.recent.length > 500) this.recent.splice(0, 100);

    const pickups = this.net.meetupsNear(from.x, from.y, this.cfg.maxWalk);
    const drops = this.net.meetupsNear(to.x, to.y, this.cfg.maxWalk, 1);
    if (!pickups.length || !drops.length) {
      r.state = 'rejected';
      r.reason = !pickups.length ? `No meetup point within ${this.cfg.maxWalk} m of the start` : `No meetup point within ${this.cfg.maxWalk} m of the destination`;
      this.stats.rejectedWalk++;
      this.emit({ kind: 'reject', text: `Rider #${r.id} can't book: ${r.reason.toLowerCase()}`, rider: r.id });
      return r;
    }
    if (pickups[0].node === drops[0].node) {
      r.state = 'rejected';
      r.reason = 'Start and destination share a meetup point — quicker to walk';
      this.stats.rejectedWalk++;
      return r;
    }
    this.active.add(r.id);
    this.emit({ kind: 'book', text: `Rider #${r.id} booked: ${from.label} → ${to.label}`, rider: r.id });
    this.tryAssign(r);
    return r;
  }

  dispatchParams(): DispatchParams {
    return {
      strategy: this.cfg.matchingStrategy,
      maxDetour: this.cfg.maxDetour,
      detourSlack: 120,
      stopDwell: this.cfg.stopDwellSec,
      boardTime: this.cfg.boardSec,
    };
  }

  travelFn() {
    const f = this.traffic();
    return (a: number, b: number) => this.net.time(a, b) / f;
  }

  busState(b: Bus): BusState {
    const traffic = this.traffic();
    let startNode: number;
    let startTime: number;
    if (b.edge >= 0) {
      startNode = b.to;
      startTime = this.now + (this.net.elen[b.edge] - b.pos) / this.net.speed(b.edge, traffic);
    } else {
      startNode = b.node;
      startTime = Math.max(this.now, b.dwellUntil);
    }
    return { id: b.id, startNode, startTime, onboard: b.onboard.length, capacity: this.cfg.seatsPerBus, stops: b.stops };
  }

  riderInfo(r: Rider): RiderInfo {
    return {
      id: r.id,
      requestTime: r.requestTime,
      readyTime: r.readyTime,
      pickupNode: r.pickupNode,
      dropoffNode: r.dropoffNode,
      directTime: r.directTime,
      latestPickup: Math.max(r.latestPickup, r.promisedPickup + 180),
      pickedUpAt: r.state === 'onboard' ? r.pickupTime : undefined,
    };
  }

  private planRiders(): Map<number, RiderInfo> {
    const m = new Map<number, RiderInfo>();
    for (const id of this.active) {
      const r = this.riders[id];
      if (r.state === 'assigned' || r.state === 'onboard') m.set(id, this.riderInfo(r));
    }
    return m;
  }

  private tryAssign(r: Rider) {
    const buses = this.buses.filter((b) => this.inService || b.stops.length > 0).map((b) => this.busState(b));
    const pickups = this.net.meetupsNear(r.from.x, r.from.y, this.cfg.maxWalk);
    const drop = this.net.meetupsNear(r.to.x, r.to.y, Math.max(this.cfg.maxWalk, 5000), 1)[0];
    const a = drop && pickups.length
      ? assign(
          {
            id: r.id,
            requestTime: this.now,
            walkSpeed: this.cfg.walkSpeed,
            pickups,
            dropoff: drop,
            maxWait: Math.max(0, r.latestPickup - this.now),
            meetupStrategy: this.cfg.meetupStrategy,
          },
          buses,
          this.planRiders(),
          this.travelFn(),
          this.dispatchParams(),
        )
      : null;
    if (!a) {
      if (r.nextRetry === r.requestTime) this.emit({ kind: 'info', text: `No bus free for rider #${r.id} yet — retrying`, rider: r.id });
      r.nextRetry = this.now + RETRY_SEC;
      return;
    }
    const bus = this.buses[a.busId];
    bus.stops = a.stops;
    r.state = 'assigned';
    r.busId = bus.id;
    r.pickupNode = a.pickupNode;
    r.dropoffNode = a.dropoffNode;
    r.walkIn = a.walk;
    r.walkOut = drop.walk;
    // Riders start walking once they are matched.
    r.readyTime = this.now + a.walk / this.cfg.walkSpeed;
    r.directTime = a.directTime;
    r.directDist = this.net.pathLength(a.pickupNode, a.dropoffNode);
    r.promisedPickup = a.pickupTime;
    r.promisedDropoff = a.dropoffTime;
    r.fare = fareFor(this.cfg, r);
    this.emit({
      kind: 'assign',
      text: `Rider #${r.id} → Bus ${bus.id + 1}: walk ${Math.round(a.walk)} m, pickup in ${fmtMin(a.pickupTime - this.now)}`,
      rider: r.id,
      bus: bus.id,
    });
  }

  private reject(r: Rider, reason: string) {
    r.state = 'rejected';
    r.reason = reason;
    this.active.delete(r.id);
    this.stats.rejectedNoBus++;
    this.emit({ kind: 'reject', text: `Rider #${r.id}: ${reason.toLowerCase()}`, rider: r.id });
  }

  private removeStops(r: Rider) {
    if (r.busId < 0) return;
    const b = this.buses[r.busId];
    b.stops = b.stops.filter((s) => s.rider !== r.id);
  }

  cancel(r: Rider, reason: string) {
    if (r.state !== 'assigned' && r.state !== 'searching') return;
    this.removeStops(r);
    r.state = 'cancelled';
    r.reason = reason;
    this.active.delete(r.id);
    this.stats.cancelled++;
    this.emit({ kind: 'cancel', text: `Rider #${r.id} cancelled: ${reason.toLowerCase()}`, rider: r.id, bus: r.busId });
  }

  // ---------------------------------------------------------------- network edits

  toggleBusStreet(wayId: number) {
    this.net.toggleBus(wayId);
    const w = this.net.ways[wayId];
    this.networkChanged(`${w.name || 'Street'} ${w.bus ? 'opened to' : 'closed to'} buses`);
  }
  toggleClosed(wayId: number) {
    this.net.toggleClosed(wayId);
    const w = this.net.ways[wayId];
    this.networkChanged(`${w.name || 'Street'} ${w.closed ? 'closed' : 'reopened'}`);
  }
  toggleJam(wayId: number) {
    const w = this.net.ways[wayId];
    this.net.setJam(wayId, w.jam < 1 ? 1 : 0.2);
    this.networkChanged(`${w.name || 'Street'}: ${w.jam < 1 ? 'traffic jam' : 'jam cleared'}`);
  }

  /** Re-plan riders whose meetup points disappeared or became unreachable. */
  private networkChanged(text: string) {
    this.emit({ kind: 'network', text });
    for (const b of this.buses) {
      b.path = [];
      b.idleTarget = -1;
    }
    for (const id of [...this.active]) {
      const r = this.riders[id];
      if (r.state === 'onboard' && !this.net.isMeetup[r.dropoffNode]) {
        const d = this.net.meetupsNear(r.to.x, r.to.y, 5000, 1)[0];
        if (d) {
          const b = this.buses[r.busId];
          for (const s of b.stops) if (s.rider === r.id) s.node = d.node;
          r.dropoffNode = d.node;
          r.walkOut = d.walk;
        }
      } else if (r.state === 'assigned' && (!this.net.isMeetup[r.pickupNode] || !this.net.isMeetup[r.dropoffNode])) {
        this.removeStops(r);
        r.state = 'searching';
        r.busId = -1;
        r.nextRetry = this.now;
        this.emit({ kind: 'info', text: `Rider #${r.id}'s meetup point moved — re-matching`, rider: r.id });
      }
    }
  }

  // ---------------------------------------------------------------- buses

  status(b: Bus): BusStatus {
    if (b.onboard.length) return 'carrying';
    if (b.stops.length) return 'toPickup';
    return this.inService ? 'idle' : 'offDuty';
  }

  private moveBus(b: Bus, dt: number, traffic: number) {
    if (this.inService || b.stops.length || b.onboard.length) {
      b.serviceSec += dt;
      this.stats.busHours += dt / 3600;
    }
    if (b.onboard.length || b.stops.length) {
      b.busySec += dt;
      this.stats.busyHours += dt / 3600;
    }
    if (this.now < b.dwellUntil) return;
    let budget = dt;
    let guard = 50;
    while (budget > 1e-9 && guard-- > 0) {
      if (b.edge < 0) {
        if (this.handleStops(b)) return;
        const target = this.targetFor(b);
        if (target < 0 || target === b.node) return;
        if (!b.path.length || b.pathTarget !== target || b.pathVersion !== this.net.version) {
          b.path = this.net.path(b.node, target);
          b.pathTarget = target;
          b.pathVersion = this.net.version;
        }
        if (!b.path.length) {
          b.idleTarget = -1;
          return;
        }
        const next = b.path.shift()!;
        const e = this.net.edgeBetween(b.node, next);
        if (e < 0) {
          b.path = [];
          return;
        }
        b.edge = e;
        b.to = next;
        b.pos = 0;
        b.fresh = false;
      }
      const len = this.net.elen[b.edge];
      const v = this.net.speed(b.edge, traffic);
      const need = (len - b.pos) / v;
      const step = need <= budget ? len - b.pos : v * budget;
      this.odometer(b, step);
      if (need <= budget) {
        budget -= need;
        b.node = b.to;
        b.edge = -1;
        b.pos = 0;
        b.fresh = true;
      } else {
        b.pos += step;
        budget = 0;
      }
    }
  }

  private odometer(b: Bus, m: number) {
    const km = m / 1000;
    b.km += km;
    this.stats.km += km;
    this.stats.seatKm += km * this.cfg.seatsPerBus;
    if (b.onboard.length) {
      b.kmLoaded += km;
      b.paxKm += km * b.onboard.length;
      this.stats.kmLoaded += km;
      this.stats.paxKm += km * b.onboard.length;
    }
  }

  /** Serve all stops at the bus's current node. Returns true if the bus has to stay put. */
  private handleStops(b: Bus): boolean {
    let moved = 0;
    while (b.stops.length && b.stops[0].node === b.node) {
      const s = b.stops[0];
      const r = this.riders[s.rider];
      if (s.kind === 'dropoff') {
        b.stops.shift();
        if (r.state !== 'onboard') continue;
        b.onboard = b.onboard.filter((id) => id !== r.id);
        r.state = 'done';
        r.dropoffTime = this.now;
        this.active.delete(r.id);
        b.trips++;
        moved++;
        this.stats.served++;
        this.stats.rides.push((r.dropoffTime - r.pickupTime) / 60);
        if (r.directTime > 0) this.stats.detours.push((r.dropoffTime - r.pickupTime) / Math.max(60, r.directTime));
        this.emit({ kind: 'dropoff', text: `Bus ${b.id + 1} dropped rider #${r.id} (${fmtMin(r.dropoffTime - r.requestTime)} door to door)`, rider: r.id, bus: b.id });
        continue;
      }
      if (r.state !== 'assigned' || r.busId !== b.id) {
        b.stops.shift();
        continue;
      }
      if (r.noShow) {
        if (b.graceUntil < 0) b.graceUntil = Math.max(this.now, r.readyTime) + this.cfg.driverGraceSec;
        if (this.now < b.graceUntil) {
          b.dwellUntil = b.graceUntil;
          return true;
        }
        b.graceUntil = -1;
        b.stops = b.stops.filter((x) => x.rider !== r.id);
        r.state = 'noshow';
        r.reason = 'Did not turn up';
        this.active.delete(r.id);
        this.stats.noShows++;
        this.emit({ kind: 'noshow', text: `Rider #${r.id} didn't show — Bus ${b.id + 1} waited ${this.cfg.driverGraceSec}s`, rider: r.id, bus: b.id });
        continue;
      }
      if (this.now < r.readyTime) {
        // The rider is still walking to the meetup point.
        b.dwellUntil = r.readyTime;
        return true;
      }
      b.stops.shift();
      r.state = 'onboard';
      r.pickupTime = this.now;
      b.onboard.push(r.id);
      moved++;
      this.stats.pickedUp++;
      this.stats.revenue += r.fare;
      this.stats.waits.push((r.pickupTime - r.requestTime) / 60);
      this.stats.walks.push(r.walkIn + r.walkOut);
      this.stats.lateness.push((r.pickupTime - r.promisedPickup) / 60);
      this.emit({ kind: 'pickup', text: `Bus ${b.id + 1} picked up rider #${r.id} after ${fmtMin(r.pickupTime - r.requestTime)}`, rider: r.id, bus: b.id });
    }
    if (moved) {
      b.dwellUntil = this.now + (b.fresh ? this.cfg.stopDwellSec : 0) + moved * this.cfg.boardSec;
      b.fresh = false;
      return true;
    }
    return false;
  }

  private targetFor(b: Bus): number {
    if (b.stops.length) return b.stops[0].node;
    if (!this.inService) return b.node;
    switch (this.cfg.idleBehaviour) {
      case 'park':
        return b.node;
      case 'patrol': {
        if (b.idleTarget < 0 || b.idleTarget === b.node || !this.net.isMeetup[b.idleTarget]) b.idleTarget = this.randomCruiseTarget(b);
        return b.idleTarget;
      }
      case 'rebalance': {
        if (b.idleTarget < 0 || this.now - b.idleChecked > 300 || !this.net.isMeetup[b.idleTarget]) {
          b.idleTarget = this.rebalanceTarget(b);
          b.idleChecked = this.now;
        }
        return b.idleTarget;
      }
    }
  }

  /** Cruise to a random meetup point 0.6–2.5 km away, favouring busy areas. */
  private randomCruiseTarget(b: Bus): number {
    const m = this.net.meetups;
    if (!m.length) return -1;
    const bx = this.net.x[b.node];
    const by = this.net.y[b.node];
    let best = m[this.opsRng.int(m.length)];
    for (let i = 0; i < 12; i++) {
      const c = m[this.opsRng.int(m.length)];
      const d = Math.hypot(this.net.x[c] - bx, this.net.y[c] - by);
      if (d > 600 && d < 2500) return c;
      best = c;
    }
    return best;
  }

  /** Head for the area with the most recent bookings per idle bus already heading there. */
  private rebalanceTarget(b: Bus): number {
    const spots = [...this.demand.hotspots.map((h) => ({ x: h.x, y: h.y })), ...this.net.gateNodes.map((g) => ({ x: g.x, y: g.y }))];
    if (!spots.length) return this.randomCruiseTarget(b);
    const since = this.now - 1800;
    let best = spots[0];
    let bestScore = -Infinity;
    for (const s of spots) {
      let demand = 0.2;
      for (const r of this.recent) if (r.t >= since && Math.hypot(r.x - s.x, r.y - s.y) < 500) demand++;
      let heading = 0;
      for (const o of this.buses) {
        if (o === b || o.stops.length || o.idleTarget < 0) continue;
        if (Math.hypot(this.net.x[o.idleTarget] - s.x, this.net.y[o.idleTarget] - s.y) < 500) heading++;
      }
      const dist = Math.hypot(this.net.x[b.node] - s.x, this.net.y[b.node] - s.y);
      const score = demand / (1 + heading) - dist / 4000;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return this.net.meetupsNear(best.x, best.y, 5000, 1)[0]?.node ?? b.node;
  }

  /** Bus position and heading for drawing. */
  busPose(b: Bus): { x: number; y: number; angle: number } {
    const n = this.net;
    if (b.edge < 0) {
      const nx = b.path[0] ?? b.stops[0]?.node;
      const angle = nx !== undefined && nx !== b.node ? Math.atan2(n.y[nx] - n.y[b.node], n.x[nx] - n.x[b.node]) : 0;
      return { x: n.x[b.node], y: n.y[b.node], angle };
    }
    const from = b.node;
    const t = b.pos / n.elen[b.edge];
    return {
      x: n.x[from] + (n.x[b.to] - n.x[from]) * t,
      y: n.y[from] + (n.y[b.to] - n.y[from]) * t,
      angle: Math.atan2(n.y[b.to] - n.y[from], n.x[b.to] - n.x[from]),
    };
  }

  /** Remaining route of a bus as a list of node ids (for drawing). */
  plannedRoute(b: Bus): number[] {
    const out: number[] = [b.edge >= 0 ? b.to : b.node];
    let at = out[0];
    for (const s of b.stops) {
      if (s.node === at) continue;
      out.push(...this.net.path(at, s.node));
      at = s.node;
    }
    return out;
  }

  private sample() {
    let waiting = 0;
    let riding = 0;
    for (const id of this.active) {
      const s = this.riders[id].state;
      if (s === 'searching' || s === 'assigned') waiting++;
      else if (s === 'onboard') riding++;
    }
    const st = { carrying: 0, toPickup: 0, idle: 0, offDuty: 0 };
    for (const b of this.buses) st[this.status(b)]++;
    const since = this.now - 1800;
    let sw = 0;
    let n = 0;
    for (let i = this.riders.length - 1; i >= 0; i--) {
      const r = this.riders[i];
      if (r.requestTime < since - 3600) break;
      if (r.pickupTime >= since) {
        sw += r.pickupTime - r.requestTime;
        n++;
      }
    }
    this.series.push({
      t: this.now,
      waiting,
      riding,
      busesCarrying: st.carrying,
      busesToPickup: st.toPickup,
      busesIdle: st.idle + st.offDuty,
      avgWait: n ? sw / n / 60 : NaN,
      bookings: this.stats.requested,
      served: this.stats.served,
    });
  }

  /** Run headless until service ends and the last rider is home (or `maxHours` pass). */
  runToEnd(maxHours = 30) {
    const limit = this.now + maxHours * 3600;
    while (!this.finished && this.now < limit) this.step();
  }
}

function newBus(id: number, node: number): Bus {
  return {
    id, node, edge: -1, to: -1, pos: 0, path: [], pathTarget: -1, pathVersion: -1, stops: [], onboard: [],
    dwellUntil: 0, graceUntil: -1, fresh: false, idleTarget: -1, idleChecked: 0,
    km: 0, kmLoaded: 0, paxKm: 0, serviceSec: 0, busySec: 0, trips: 0,
  };
}

function emptyStats(): Stats {
  return {
    requested: 0, pickedUp: 0, served: 0, cancelled: 0, rejectedWalk: 0, rejectedNoBus: 0, noShows: 0,
    waits: [], walks: [], rides: [], detours: [], lateness: [],
    revenue: 0, km: 0, kmLoaded: 0, paxKm: 0, seatKm: 0, busHours: 0, busyHours: 0,
  };
}

export function fmtMin(sec: number) {
  const m = sec / 60;
  return m < 1 ? `${Math.max(0, Math.round(sec))} s` : `${m.toFixed(m < 10 ? 1 : 0)} min`;
}
