// "Compare scenarios": run whole simulated days for a range of one setting, in a Web Worker.
import { ALL_PARAMS, type NumberSpec, type SimConfig } from '../sim/config';
import type { StreetState, SweepPoint } from '../sim/sweep';
import SweepWorker from '../sweep.worker?worker&inline';
import { LineChart } from './chart';
import { naira } from './dashboard';

interface Option {
  key: keyof SimConfig;
  from: number;
  to: number;
  steps: number;
}
const OPTIONS: Option[] = [
  { key: 'fleetSize', from: 2, to: 20, steps: 10 },
  { key: 'bookingsPerHour', from: 50, to: 500, steps: 10 },
  { key: 'seatsPerBus', from: 7, to: 18, steps: 6 },
  { key: 'meetupSpacing', from: 100, to: 500, steps: 9 },
  { key: 'maxWalk', from: 200, to: 1000, steps: 9 },
  { key: 'maxWaitMin', from: 5, to: 25, steps: 9 },
  { key: 'fare', from: 200, to: 1500, steps: 8 },
  { key: 'evShare', from: 0, to: 1, steps: 6 },
  { key: 'batteryKWh', from: 30, to: 120, steps: 7 },
  { key: 'chargerKW', from: 11, to: 120, steps: 6 },
  { key: 'chargers', from: 1, to: 6, steps: 6 },
  { key: 'electricityPrice', from: 100, to: 400, steps: 7 },
  { key: 'evBusCostPerHour', from: 1500, to: 6000, steps: 7 },
  { key: 'busCostPerHour', from: 1000, to: 6000, steps: 6 },
  { key: 'trafficLevel', from: 0.3, to: 1.1, steps: 9 },
];

export class SweepPanel {
  private worker: Worker | null = null;
  private results: SweepPoint[] = [];
  private charts: LineChart[];
  private els: Record<string, HTMLElement> = {};

  constructor(
    host: HTMLElement,
    private getCfg: () => SimConfig,
    private getStreets: () => StreetState,
  ) {
    const opts = OPTIONS.map((o) => `<option value="${o.key}">${spec(o.key).label}</option>`).join('');
    host.innerHTML = `
      <div class="panel-section">
        <p class="note">Run whole simulated days (${'service hours'} from your settings, same streets and rules) while varying one setting, to size the pilot. Each day takes a few seconds.</p>
        <form class="sweep-form" id="sweep-form">
          <label class="full">Vary<select id="sweep-param">${opts}</select></label>
          <label>From<input id="sweep-from" type="number" step="any"></label>
          <label>To<input id="sweep-to" type="number" step="any"></label>
          <label>Points<input id="sweep-steps" type="number" min="2" max="15" step="1"></label>
          <label class="full">Days per point (different random seeds)<select id="sweep-seeds"><option value="1">1 — quick</option><option value="2">2</option><option value="3">3 — steadier averages</option></select></label>
          <label>Target picked up<select id="sweep-target-served"><option value="0.8">80%</option><option value="0.9" selected>90%</option><option value="0.95">95%</option></select></label>
          <label>Target avg wait<select id="sweep-target-wait"><option value="5">5 min</option><option value="8" selected>8 min</option><option value="10">10 min</option><option value="15">15 min</option></select></label>
          <label>&nbsp;<button class="btn primary" id="sweep-run" type="submit">Run</button></label>
        </form>
        <progress id="sweep-progress" value="0" max="1" hidden></progress>
        <div id="sweep-status" class="note" aria-live="polite"></div>
      </div>
      <div class="panel-section" id="sweep-results" hidden>
        <div class="recommend" id="sweep-rec"></div>
        <div id="sweep-charts" style="display:grid;gap:14px"></div>
        <div class="table-scroll"><table id="sweep-table"></table></div>
      </div>`;
    for (const id of ['sweep-form', 'sweep-param', 'sweep-from', 'sweep-to', 'sweep-steps', 'sweep-seeds', 'sweep-run', 'sweep-progress', 'sweep-status', 'sweep-results', 'sweep-rec', 'sweep-charts', 'sweep-table', 'sweep-target-served', 'sweep-target-wait'])
      this.els[id] = host.querySelector(`#${id}`)!;
    this.charts = [
      new LineChart({ title: 'Riders picked up (% of bookings in walking reach)', fmtY: (v) => `${Math.round(v)}%`, fmtX: (v) => String(v), yMin: 0, dots: true }),
      new LineChart({ title: 'Average wait for pickup (min)', fmtY: (v) => v.toFixed(v < 10 ? 1 : 0), fmtX: (v) => String(v), yMin: 0, dots: true }),
      new LineChart({ title: 'Profit per service hour (₦)', fmtY: (v) => `${Math.round(v / 1000)}k`, fmtX: (v) => String(v), dots: true }),
      new LineChart({ title: 'Average riders on a moving bus', fmtY: (v) => v.toFixed(1), fmtX: (v) => String(v), yMin: 0, dots: true }),
    ];
    for (const c of this.charts) this.els['sweep-charts'].append(c.el);
    const param = this.els['sweep-param'] as HTMLSelectElement;
    param.addEventListener('change', () => this.setDefaults());
    this.setDefaults();
    this.els['sweep-form'].addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.worker) this.stop();
      else this.run();
    });
    for (const id of ['sweep-target-served', 'sweep-target-wait']) this.els[id].addEventListener('change', () => this.render());
  }

  private setDefaults() {
    const key = (this.els['sweep-param'] as HTMLSelectElement).value as keyof SimConfig;
    const o = OPTIONS.find((x) => x.key === key)!;
    (this.els['sweep-from'] as HTMLInputElement).value = String(o.from);
    (this.els['sweep-to'] as HTMLInputElement).value = String(o.to);
    (this.els['sweep-steps'] as HTMLInputElement).value = String(o.steps);
  }

  private values(): number[] {
    const key = (this.els['sweep-param'] as HTMLSelectElement).value as keyof SimConfig;
    const s = spec(key);
    const a = Number((this.els['sweep-from'] as HTMLInputElement).value);
    const b = Number((this.els['sweep-to'] as HTMLInputElement).value);
    const n = Math.max(2, Math.min(15, Math.round(Number((this.els['sweep-steps'] as HTMLInputElement).value))));
    const out = new Set<number>();
    for (let i = 0; i < n; i++) {
      let v = a + ((b - a) * i) / (n - 1);
      v = Math.round(v / s.step) * s.step;
      v = Math.max(s.min, Math.min(s.max, +v.toFixed(4)));
      out.add(v);
    }
    return [...out];
  }

  private run() {
    const key = (this.els['sweep-param'] as HTMLSelectElement).value as keyof SimConfig;
    const values = this.values();
    const seeds = Number((this.els['sweep-seeds'] as HTMLSelectElement).value);
    this.results = [];
    this.param = key;
    const prog = this.els['sweep-progress'] as HTMLProgressElement;
    prog.hidden = false;
    prog.max = values.length;
    prog.value = 0;
    this.els['sweep-run'].textContent = 'Stop';
    this.els['sweep-status'].textContent = `Simulating ${values.length * seeds} days…`;
    const w = new SweepWorker();
    this.worker = w;
    w.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'point') {
        this.results[e.data.index] = e.data.point;
        prog.value = this.results.filter(Boolean).length;
        this.els['sweep-status'].textContent = `${prog.value} of ${values.length} done`;
        this.render();
      } else if (e.data.type === 'done') {
        this.els['sweep-status'].textContent = `Done: ${values.length} settings × ${seeds} day${seeds > 1 ? 's' : ''}.`;
        this.finish();
      }
    };
    w.onerror = (e) => {
      this.els['sweep-status'].textContent = `The comparison stopped with an error: ${e.message}`;
      this.finish();
    };
    w.postMessage({ cfg: this.getCfg(), streets: this.getStreets(), param: key, values, seeds });
  }

  private param: keyof SimConfig = 'fleetSize';

  private stop() {
    this.els['sweep-status'].textContent = 'Stopped.';
    this.finish();
  }

  private finish() {
    this.worker?.terminate();
    this.worker = null;
    this.els['sweep-run'].textContent = 'Run';
    (this.els['sweep-progress'] as HTMLProgressElement).hidden = true;
  }

  private render() {
    const pts = this.results.filter(Boolean);
    if (!pts.length) return;
    this.els['sweep-results'].hidden = false;
    const s = spec(this.param);
    const fx = (v: number) => (s.format ? s.format(v) : `${v}${s.unit ? ` ${s.unit}` : ''}`);
    const xs = pts.map((p) => p.value);
    const mark = this.getCfg()[this.param] as number;
    const data = [
      pts.map((p) => p.summary.serviceRate * 100),
      pts.map((p) => p.summary.avgWait),
      pts.map((p) => p.summary.profitPerHour),
      pts.map((p) => p.summary.avgLoad),
    ];
    this.charts.forEach((c, i) => {
      c.setOptions({ fmtX: fx, markX: mark });
      c.setData(xs, [{ name: c.el.querySelector('.chart-title')!.textContent!, color: '--s1', values: data[i] }]);
    });
    (this.els['sweep-table'] as HTMLTableElement).innerHTML = `<thead><tr><th>${s.label}</th><th>Picked up</th><th>Avg wait</th><th>p90 wait</th><th>In reach</th><th>Walk</th><th>Riders/bus</th><th>Profit/h</th><th>Break-even fare</th><th>CO₂/ride</th><th>Charging</th></tr></thead><tbody>${pts
      .map((p) => `<tr><th scope="row">${fx(p.value)}</th><td>${Math.round(p.summary.serviceRate * 100)}%</td><td>${p.summary.avgWait.toFixed(1)} min</td><td>${p.summary.p90Wait.toFixed(1)} min</td><td>${Math.round(p.summary.reachRate * 100)}%</td><td>${Math.round(p.summary.avgWalk)} m</td><td>${p.summary.avgLoad.toFixed(1)}</td><td>${naira(p.summary.profitPerHour)}</td><td>${naira(p.summary.breakEvenFare)}</td><td>${p.summary.co2PerRide.toFixed(2)} kg</td><td>${Math.round(p.summary.chargingShare * 100)}%</td></tr>`)
      .join('')}</tbody>`;

    const tServed = Number((this.els['sweep-target-served'] as HTMLSelectElement).value);
    const tWait = Number((this.els['sweep-target-wait'] as HTMLSelectElement).value);
    const ok = pts.filter((p) => p.summary.serviceRate >= tServed && p.summary.avgWait <= tWait);
    const bestProfit = pts.reduce((a, b) => (b.summary.profitPerHour > a.summary.profitPerHour ? b : a));
    let rec = '';
    if (ok.length) {
      // the cheapest option that meets targets: lowest value for cost-like params, else most profitable
      const pick = this.param === 'fleetSize' || this.param === 'seatsPerBus' ? ok[0] : ok.reduce((a, b) => (b.summary.profitPerHour > a.summary.profitPerHour ? b : a));
      rec = `<strong>${s.label}: ${fx(pick.value)}</strong> is the ${this.param === 'fleetSize' || this.param === 'seatsPerBus' ? 'smallest' : 'most profitable'} setting that picks up ≥${Math.round(tServed * 100)}% of riders with an average wait ≤${tWait} min (${Math.round(pick.summary.serviceRate * 100)}% · ${pick.summary.avgWait.toFixed(1)} min · ${naira(pick.summary.profitPerHour)}/h).`;
    } else {
      rec = `<strong>No setting in this range meets both targets.</strong> Try a wider range or more buses.`;
    }
    rec += `<br><span class="note">Most profitable: ${fx(bestProfit.value)} (${naira(bestProfit.summary.profitPerHour)}/h).</span>`;
    this.els['sweep-rec'].innerHTML = rec;
  }
}

function spec(key: keyof SimConfig): NumberSpec {
  return ALL_PARAMS.find((p) => p.key === key) as NumberSpec;
}
