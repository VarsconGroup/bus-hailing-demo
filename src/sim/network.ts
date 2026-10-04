// Street graph, bus-navigable subset, meetup points and shortest-path routing.
//
// Coordinates are metres: x east, y south (screen orientation).
// All streets are treated as two-way, so travel times are symmetric and every shortest-path
// tree is rooted at a *destination*: tree(t).next[x] is the next node on the way from x to t.

export type RoadClass = 'expressway' | 'arterial' | 'collector' | 'local';
export type Pt = [number, number];

export interface RawWay {
  name: string;
  cls: RoadClass;
  bus: boolean;
  nodes: number[];
}
export interface RawNetwork {
  source: 'osm' | 'schematic';
  attribution?: string;
  origin?: { lat: number; lon: number };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  zone: Pt[];
  nodes: Pt[];
  ways: RawWay[];
  context: { cls: RoadClass; pts: Pt[] }[];
  water: { kind: 'pond' | 'stream' | 'shore'; pts: Pt[] }[];
  gates: { name: string; x: number; y: number }[];
  pois: { name: string; kind: string; x: number; y: number }[];
}

/** Free-flow speeds in m/s. */
export const CLASS_SPEED: Record<RoadClass, number> = {
  expressway: 55 / 3.6,
  arterial: 35 / 3.6,
  collector: 28 / 3.6,
  local: 20 / 3.6,
};

/** Buses can still crawl along a non-bus street (e.g. one that was banned while a bus was on it), but it costs this much more. */
const NON_BUS_PENALTY = 60;
const MAX_SEGMENT = 40; // metres; bus streets are subdivided so meetups can be placed finely
export const WALK_DETOUR = 1.3; // walking distance ≈ straight line × this

export interface Way {
  id: number;
  name: string;
  cls: RoadClass;
  bus: boolean;
  closed: boolean;
  jam: number; // speed multiplier, 1 = normal, 0.25 = heavy jam
  nodes: number[]; // after subdivision
  length: number;
}

export interface Tree {
  dist: Float64Array; // base seconds to the root
  next: Int32Array; // next node towards the root, -1 at the root / unreachable
}

export class Network {
  readonly raw: RawNetwork;
  x: number[] = [];
  y: number[] = [];
  ways: Way[] = [];
  /** per edge: from, to, length, way */
  ea: number[] = [];
  eb: number[] = [];
  elen: number[] = [];
  eway: number[] = [];
  adj: number[][] = []; // node -> edge ids
  version = 0;

  meetups: number[] = [];
  isMeetup: Uint8Array = new Uint8Array(0);
  gateNodes: { name: string; node: number; x: number; y: number }[] = [];
  private spacing = 200;
  private meetupGrid = new Map<string, number[]>();
  private segGrid = new Map<string, number[]>();
  private trees = new Map<number, Tree>();
  private edgeTime: Float64Array = new Float64Array(0);
  /** bus-street component id per node (-1 = not on a bus street) */
  busComp: Int32Array = new Int32Array(0);
  mainComp = -1;

  constructor(raw: RawNetwork, meetupSpacing = 200) {
    this.raw = raw;
    this.x = raw.nodes.map((n) => n[0]);
    this.y = raw.nodes.map((n) => n[1]);
    for (const w of raw.ways) this.addWay(w);
    this.buildSegGrid();
    this.spacing = meetupSpacing;
    this.rebuild();
  }

  get nodeCount() {
    return this.x.length;
  }

  private addNode(x: number, y: number): number {
    this.x.push(x);
    this.y.push(y);
    return this.x.length - 1;
  }

  private addWay(w: RawWay) {
    const id = this.ways.length;
    const nodes: number[] = [w.nodes[0]];
    let length = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1];
      const b = w.nodes[i];
      const d = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]);
      if (d < 0.01) continue;
      length += d;
      const pieces = w.cls === 'local' ? 1 : Math.ceil(d / MAX_SEGMENT);
      let prev = a;
      for (let k = 1; k <= pieces; k++) {
        const n = k === pieces ? b : this.addNode(this.x[a] + ((this.x[b] - this.x[a]) * k) / pieces, this.y[a] + ((this.y[b] - this.y[a]) * k) / pieces);
        this.addEdge(prev, n, id);
        nodes.push(n);
        prev = n;
      }
    }
    this.ways.push({ id, name: w.name, cls: w.cls, bus: w.bus, closed: false, jam: 1, nodes, length });
  }

  private addEdge(a: number, b: number, way: number) {
    const e = this.ea.length;
    this.ea.push(a);
    this.eb.push(b);
    this.elen.push(Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]));
    this.eway.push(way);
    (this.adj[a] ??= []).push(e);
    (this.adj[b] ??= []).push(e);
  }

  /** Edge id joining two adjacent nodes, or -1. */
  edgeBetween(a: number, b: number): number {
    for (const e of this.adj[a] ?? []) if (this.ea[e] === b || this.eb[e] === b) return e;
    return -1;
  }

  other(e: number, n: number) {
    return this.ea[e] === n ? this.eb[e] : this.ea[e];
  }

  isBusEdge(e: number) {
    const w = this.ways[this.eway[e]];
    return w.bus && !w.closed;
  }

  /** Bus speed on an edge in m/s for a global traffic factor. */
  speed(e: number, traffic: number) {
    const w = this.ways[this.eway[e]];
    const s = CLASS_SPEED[w.cls] * w.jam * traffic;
    return this.isBusEdge(e) ? s : s / 4;
  }

  setMeetupSpacing(m: number) {
    if (m === this.spacing) return;
    this.spacing = m;
    this.rebuild();
  }

  toggleBus(wayId: number) {
    const w = this.ways[wayId];
    w.bus = !w.bus;
    this.rebuild();
  }
  toggleClosed(wayId: number) {
    const w = this.ways[wayId];
    w.closed = !w.closed;
    this.rebuild();
  }
  setJam(wayId: number, factor: number) {
    this.ways[wayId].jam = factor;
    this.rebuild(false);
  }

  /** Recompute edge costs, bus components and (optionally) meetup points; invalidates routes. */
  rebuild(meetups = true) {
    this.version++;
    this.trees.clear();
    const E = this.ea.length;
    this.edgeTime = new Float64Array(E);
    for (let e = 0; e < E; e++) {
      const w = this.ways[this.eway[e]];
      if (w.closed) this.edgeTime[e] = Infinity;
      else {
        const t = this.elen[e] / (CLASS_SPEED[w.cls] * w.jam);
        this.edgeTime[e] = w.bus ? t : t * NON_BUS_PENALTY;
      }
    }
    this.computeBusComponents();
    if (meetups) this.placeMeetups();
  }

  private computeBusComponents() {
    const N = this.nodeCount;
    const comp = new Int32Array(N).fill(-1);
    const sizes: number[] = [];
    for (let s = 0; s < N; s++) {
      if (comp[s] !== -1 || !(this.adj[s] ?? []).some((e) => this.isBusEdge(e))) continue;
      const c = sizes.length;
      let size = 0;
      const stack = [s];
      comp[s] = c;
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (const e of this.adj[u] ?? []) {
          if (!this.isBusEdge(e)) continue;
          const v = this.other(e, u);
          if (comp[v] === -1) {
            comp[v] = c;
            stack.push(v);
          }
        }
      }
      sizes.push(size);
    }
    this.busComp = comp;
    this.mainComp = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  }

  /** Can a bus stop at this node? (on the main bus network, not on the expressway) */
  private stoppable(n: number) {
    if (this.busComp[n] !== this.mainComp || this.mainComp < 0) return false;
    let ok = false;
    for (const e of this.adj[n] ?? []) {
      if (!this.isBusEdge(e)) continue;
      if (this.ways[this.eway[e]].cls === 'expressway') return false;
      ok = true;
    }
    return ok;
  }

  private busDegree(n: number) {
    let d = 0;
    for (const e of this.adj[n] ?? []) if (this.isBusEdge(e)) d++;
    return d;
  }

  /**
   * Greedy meetup placement: gates first, then junctions of bus streets, then points along
   * the corridors, never two within `spacing` metres of each other.
   */
  private placeMeetups() {
    const N = this.nodeCount;
    const chosen: number[] = [];
    const grid = new Map<string, number[]>();
    const cell = Math.max(50, this.spacing);
    const key = (cx: number, cy: number) => `${cx},${cy}`;
    const tooClose = (n: number, minD: number) => {
      const cx = Math.floor(this.x[n] / cell);
      const cy = Math.floor(this.y[n] / cell);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (const m of grid.get(key(cx + i, cy + j)) ?? []) if (Math.hypot(this.x[m] - this.x[n], this.y[m] - this.y[n]) < minD) return true;
      return false;
    };
    const take = (n: number) => {
      chosen.push(n);
      const k = key(Math.floor(this.x[n] / cell), Math.floor(this.y[n] / cell));
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(n);
    };

    this.gateNodes = [];
    for (const g of this.raw.gates) {
      const n = this.nearestNode(g.x, g.y, (k) => this.stoppable(k));
      if (n < 0) continue;
      this.gateNodes.push({ name: g.name, node: n, x: g.x, y: g.y });
      if (!tooClose(n, 1)) take(n);
    }
    const candidates: number[] = [];
    for (let n = 0; n < N; n++) if (this.stoppable(n)) candidates.push(n);
    // Junctions first (they serve several streets), then the rest in a stable order.
    candidates.sort((a, b) => this.busDegree(b) - this.busDegree(a) || a - b);
    for (const n of candidates) if (!tooClose(n, this.spacing)) take(n);

    this.meetups = chosen;
    this.isMeetup = new Uint8Array(N);
    for (const m of chosen) this.isMeetup[m] = 1;
    this.meetupGrid = new Map();
    for (const m of chosen) {
      const k = `${Math.floor(this.x[m] / 100)},${Math.floor(this.y[m] / 100)}`;
      (this.meetupGrid.get(k) ?? this.meetupGrid.set(k, []).get(k)!).push(m);
    }
  }

  /** Meetup points within `maxWalk` (walking distance), nearest first. */
  meetupsNear(x: number, y: number, maxWalk: number, limit = 8): { node: number; walk: number }[] {
    const R = Math.ceil(maxWalk / WALK_DETOUR / 100);
    const cx = Math.floor(x / 100);
    const cy = Math.floor(y / 100);
    const out: { node: number; walk: number }[] = [];
    // Expand square rings of 100 m cells; stop once `limit` points are found and no unvisited
    // cell can hold anything closer.
    for (let r = 0; r <= R; r++) {
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          for (const m of this.meetupGrid.get(`${cx + i},${cy + j}`) ?? []) {
            const walk = Math.hypot(this.x[m] - x, this.y[m] - y) * WALK_DETOUR;
            if (walk <= maxWalk) out.push({ node: m, walk });
          }
        }
      if (out.length >= limit) {
        out.sort((a, b) => a.walk - b.walk);
        if (out[limit - 1].walk <= r * 100 * WALK_DETOUR) break;
      }
    }
    out.sort((a, b) => a.walk - b.walk);
    return out.slice(0, limit);
  }

  nearestNode(x: number, y: number, filter: (n: number) => boolean = () => true): number {
    let best = -1;
    let bd = Infinity;
    for (let n = 0; n < this.nodeCount; n++) {
      if (!filter(n)) continue;
      const d = (this.x[n] - x) ** 2 + (this.y[n] - y) ** 2;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  private buildSegGrid() {
    for (let e = 0; e < this.ea.length; e++) {
      const a = this.ea[e];
      const b = this.eb[e];
      const minx = Math.floor(Math.min(this.x[a], this.x[b]) / 100);
      const maxx = Math.floor(Math.max(this.x[a], this.x[b]) / 100);
      const miny = Math.floor(Math.min(this.y[a], this.y[b]) / 100);
      const maxy = Math.floor(Math.max(this.y[a], this.y[b]) / 100);
      for (let i = minx; i <= maxx; i++)
        for (let j = miny; j <= maxy; j++) {
          const k = `${i},${j}`;
          (this.segGrid.get(k) ?? this.segGrid.set(k, []).get(k)!).push(e);
        }
    }
  }

  /** The street (way id) nearest to a point within `tol` metres, or -1. */
  wayAt(x: number, y: number, tol: number): number {
    let best = -1;
    let bd = tol;
    const r = Math.ceil(tol / 100);
    const cx = Math.floor(x / 100);
    const cy = Math.floor(y / 100);
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        for (const e of this.segGrid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = distToSeg(x, y, this.x[this.ea[e]], this.y[this.ea[e]], this.x[this.eb[e]], this.y[this.eb[e]]);
          if (d < bd) {
            bd = d;
            best = this.eway[e];
          }
        }
    return best;
  }

  /** Shortest-path tree towards `root` (cached until the network changes). */
  tree(root: number): Tree {
    let t = this.trees.get(root);
    if (t) return t;
    const N = this.nodeCount;
    const dist = new Float64Array(N).fill(Infinity);
    const next = new Int32Array(N).fill(-1);
    dist[root] = 0;
    const heap = new MinHeap();
    heap.push(root, 0);
    while (heap.size) {
      const [u, du] = heap.pop();
      if (du > dist[u]) continue;
      for (const e of this.adj[u] ?? []) {
        const v = this.other(e, u);
        const nd = du + this.edgeTime[e];
        if (nd < dist[v]) {
          dist[v] = nd;
          next[v] = u;
          heap.push(v, nd);
        }
      }
    }
    t = { dist, next };
    this.trees.set(root, t);
    return t;
  }

  /** Free-flow bus travel time in seconds (divide by the traffic factor for real time). */
  time(from: number, to: number): number {
    if (from === to) return 0;
    if (this.trees.has(to) || this.isMeetup[to]) return this.tree(to).dist[from];
    return this.tree(from).dist[to];
  }

  /** Node sequence from `from` to `to`, excluding `from`. Empty if unreachable or equal. */
  path(from: number, to: number): number[] {
    const t = this.tree(to);
    if (!isFinite(t.dist[from])) return [];
    const out: number[] = [];
    let n = from;
    let guard = this.nodeCount;
    while (n !== to && guard-- > 0) {
      n = t.next[n];
      if (n < 0) return [];
      out.push(n);
    }
    return out;
  }

  /** Bus-route distance in metres along the fastest path. */
  pathLength(from: number, to: number): number {
    let d = 0;
    let prev = from;
    for (const n of this.path(from, to)) {
      d += this.elen[this.edgeBetween(prev, n)];
      prev = n;
    }
    return d;
  }

  /** Total length (m) of each class of street, split by bus/non-bus. */
  stats() {
    let bus = 0;
    let all = 0;
    for (const w of this.ways) {
      all += w.length;
      if (w.bus && !w.closed) bus += w.length;
    }
    return { totalKm: all / 1000, busKm: bus / 1000, meetups: this.meetups.length };
  }
}

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
