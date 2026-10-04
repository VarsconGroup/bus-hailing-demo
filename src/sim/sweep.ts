// Batch runs for "Compare scenarios": one simulated day per (value, seed), headless.
import type { SimConfig } from './config';
import { summarize, type Summary } from './economics';
import { Network, type RawNetwork } from './network';
import { Simulation } from './simulation';

export interface StreetState {
  bus: boolean[];
  closed: boolean[];
  jam: number[];
}

export interface SweepRequest {
  cfg: SimConfig;
  streets: StreetState;
  param: keyof SimConfig;
  values: number[];
  seeds: number;
}

export interface SweepPoint {
  value: number;
  summary: Summary; // averaged over seeds
}

export function applyStreets(net: Network, s: StreetState) {
  net.ways.forEach((w, i) => {
    w.bus = s.bus[i] ?? w.bus;
    w.closed = s.closed[i] ?? w.closed;
    w.jam = s.jam[i] ?? w.jam;
  });
  net.rebuild();
}

export function runPoint(raw: RawNetwork, net: Network, cfg: SimConfig, param: keyof SimConfig, value: number, seeds: number): SweepPoint {
  const runs: Summary[] = [];
  for (let k = 0; k < seeds; k++) {
    const c = { ...cfg, [param]: value, seed: cfg.seed + k * 101 } as SimConfig;
    const sim = new Simulation(raw, c, net);
    sim.runToEnd();
    runs.push(summarize(sim.cfg, sim.stats, sim.cfg.serviceEnd - sim.cfg.serviceStart));
  }
  return { value, summary: averageSummaries(runs) };
}

export function averageSummaries(runs: Summary[]): Summary {
  const out = { ...runs[0] } as Record<string, number>;
  for (const k of Object.keys(out)) {
    const vals = runs.map((r) => (r as unknown as Record<string, number>)[k]).filter((v) => isFinite(v));
    out[k] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : NaN;
  }
  return out as unknown as Summary;
}
