// Where and when riders appear. All numbers here are planning assumptions, not measured data.
import type { Network } from './network';
import type { Rng } from './rng';

export type PlaceKind = 'home' | 'hotspot' | 'gate';
export interface Place {
  x: number;
  y: number;
  kind: PlaceKind;
  label: string;
}
export interface Hotspot {
  name: string;
  x: number;
  y: number;
  weight: number;
  kinds: string[];
}

const KIND_WEIGHT: Record<string, number> = {
  shopping: 3, office: 2.5, school: 2.5, food: 1.5, bank: 1.5, health: 1.5, worship: 0.6, fuel: 0.3,
};
const KIND_RANK = ['shopping', 'school', 'office', 'health', 'food', 'bank', 'worship', 'fuel'];

/** Groups points of interest within ~250 m into weighted demand hotspots. */
export function buildHotspots(pois: { name: string; kind: string; x: number; y: number }[], radius = 250): Hotspot[] {
  const left = pois.map((p) => ({ ...p, w: KIND_WEIGHT[p.kind] ?? 1 }));
  const out: Hotspot[] = [];
  while (left.length) {
    // Seed each cluster at the POI with the heaviest neighbourhood.
    let bi = 0;
    let bw = -1;
    for (let i = 0; i < left.length; i++) {
      let w = 0;
      for (const q of left) if (Math.hypot(q.x - left[i].x, q.y - left[i].y) < radius) w += q.w;
      if (w > bw) {
        bw = w;
        bi = i;
      }
    }
    const seed = left[bi];
    const members = left.filter((q) => Math.hypot(q.x - seed.x, q.y - seed.y) < radius);
    for (const m of members) left.splice(left.indexOf(m), 1);
    const W = members.reduce((s, m) => s + m.w, 0);
    const named = members
      .filter((m) => m.name)
      .sort((a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind) || b.w - a.w);
    const name = named.length ? named[0].name + (members.length > 1 ? ` area` : '') : 'Local businesses';
    out.push({
      name,
      x: members.reduce((s, m) => s + m.x * m.w, 0) / W,
      y: members.reduce((s, m) => s + m.y * m.w, 0) / W,
      weight: W,
      kinds: [...new Set(members.map((m) => m.kind))],
    });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Relative demand by hour of day (0-24), before normalisation. Morning and evening commute peaks. */
export function rawProfile(h: number): number {
  const g = (mu: number, s: number) => Math.exp(-(((h - mu) / s) ** 2));
  return 0.35 + 1.25 * g(7.75, 1.1) + 1.0 * g(17.75, 1.3) + 0.35 * g(13, 1.6);
}

/** How congested the roads are by hour (0 = free flow, 1 = worst peak). */
export function peakness(h: number): number {
  const g = (mu: number, s: number) => Math.exp(-(((h - mu) / s) ** 2));
  return Math.min(1, 1.0 * g(8, 1.2) + 0.9 * g(18, 1.5) + 0.3 * g(13, 1.5));
}

export class Demand {
  readonly hotspots: Hotspot[];
  private homeWays: { a: number; b: number; len: number }[] = [];
  private homeCum: number[] = [];
  private homeTotal = 0;
  private profileMean = 1;

  constructor(
    private net: Network,
    serviceStart: number,
    serviceEnd: number,
  ) {
    this.hotspots = buildHotspots(net.raw.pois.filter((p) => p.kind !== 'other'));
    // Homes line the residential (local) streets; fall back to all streets if there are none.
    const useAll = !net.ways.some((w) => w.cls === 'local');
    for (let e = 0; e < net.ea.length; e++) {
      const w = net.ways[net.eway[e]];
      if (!useAll && w.cls !== 'local') continue;
      this.homeWays.push({ a: net.ea[e], b: net.eb[e], len: net.elen[e] });
      this.homeTotal += net.elen[e];
      this.homeCum.push(this.homeTotal);
    }
    this.setServiceWindow(serviceStart, serviceEnd);
  }

  setServiceWindow(start: number, end: number) {
    let s = 0;
    let n = 0;
    for (let h = start; h < end; h += 0.1) {
      s += rawProfile(h);
      n++;
    }
    this.profileMean = n ? s / n : 1;
  }

  /** Demand multiplier at hour h, averaging 1 over the service window. */
  profile(h: number): number {
    return rawProfile(h) / this.profileMean;
  }

  home(rng: Rng): Place {
    const r = rng.next() * this.homeTotal;
    let lo = 0;
    let hi = this.homeCum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.homeCum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const seg = this.homeWays[lo];
    const net = this.net;
    const t = rng.next();
    const ax = net.x[seg.a];
    const ay = net.y[seg.a];
    const dx = net.x[seg.b] - ax;
    const dy = net.y[seg.b] - ay;
    const l = Math.hypot(dx, dy) || 1;
    const off = (rng.next() < 0.5 ? -1 : 1) * rng.range(8, 25);
    return { x: ax + dx * t + (-dy / l) * off, y: ay + dy * t + (dx / l) * off, kind: 'home', label: 'Home' };
  }

  hotspot(rng: Rng): Place {
    const h = rng.pickWeighted(this.hotspots, (s) => s.weight);
    return { x: h.x + rng.normal() * 40, y: h.y + rng.normal() * 40, kind: 'hotspot', label: h.name };
  }

  gate(rng: Rng): Place {
    const g = this.net.gateNodes[rng.int(this.net.gateNodes.length)];
    return { x: g.x + rng.normal() * 15, y: g.y + rng.normal() * 15, kind: 'gate', label: g.name };
  }

  /**
   * A random trip at hour h. Mornings lean towards home → gate/work, evenings back home.
   * `edgeShare` = share of commute trips that go to/from the edge gates;
   * `hotspotShare` = share of local trip ends at a hotspot rather than a home.
   */
  trip(rng: Rng, h: number, edgeShare: number, hotspotShare: number, minDist = 500): { from: Place; to: Place } {
    const g = (mu: number, s: number) => Math.exp(-(((h - mu) / s) ** 2));
    const am = g(7.75, 1.5);
    const pm = g(17.75, 1.8);
    const hasGates = this.net.gateNodes.length > 0;
    const hasHot = this.hotspots.length > 0;
    const away = (): Place => (hasGates && rng.next() < edgeShare ? this.gate(rng) : hasHot ? this.hotspot(rng) : this.home(rng));
    const local = (): Place => (hasHot && rng.next() < hotspotShare ? this.hotspot(rng) : this.home(rng));
    for (let i = 0; i < 20; i++) {
      const k = rng.pickWeighted(
        [
          { t: 'out', w: 1 + 2.5 * am },
          { t: 'in', w: 1 + 2.5 * pm },
          { t: 'local', w: 1.3 },
        ],
        (o) => o.w,
      ).t;
      const from = k === 'out' ? this.home(rng) : k === 'in' ? away() : local();
      const to = k === 'out' ? away() : k === 'in' ? this.home(rng) : local();
      if (Math.hypot(to.x - from.x, to.y - from.y) >= minDist) return { from, to };
    }
    return { from: this.home(rng), to: hasGates ? this.gate(rng) : this.home(rng) };
  }
}
