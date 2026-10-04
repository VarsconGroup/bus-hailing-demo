// Right-hand rail: KPIs, outcome breakdown, live charts, inspector and event log.
import { clock } from '../sim/config';
import { summarize } from '../sim/economics';
import { fmtMin, type Rider, type Simulation } from '../sim/simulation';
import { LineChart } from './chart';
import type { Selection } from './mapView';

export const naira = (v: number) => (isFinite(v) ? `${v < 0 ? '−' : ''}₦${Math.abs(Math.round(v)).toLocaleString('en-NG')}` : '–');
const num = (v: number, d = 1) => (isFinite(v) ? v.toFixed(d) : '–');
const pct = (v: number) => (isFinite(v) ? `${Math.round(v * 100)}%` : '–');

const STATE_LABEL: Record<Rider['state'], string> = {
  searching: 'Finding a bus',
  assigned: 'Bus on the way',
  onboard: 'On board',
  done: 'Arrived',
  cancelled: 'Cancelled',
  rejected: 'Not served',
  noshow: 'No-show',
};

export class Dashboard {
  private kpis: HTMLElement;
  private outcomes: HTMLElement;
  private inspector: HTMLElement;
  private coverageEl: HTMLElement;
  private logEl: HTMLUListElement;
  private chartRiders: LineChart;
  private chartFleet: LineChart;
  private chartWait: LineChart;
  private lastSeries = -1;
  private lastLog = -1;
  coverage = NaN;
  onPick?: (s: Selection) => void;

  constructor(host: HTMLElement) {
    host.innerHTML = `
      <section class="panel-section" aria-labelledby="kpi-h"><h2 class="section-title" id="kpi-h">Today so far</h2><div class="kpis"></div></section>
      <section class="panel-section" aria-labelledby="out-h"><h2 class="section-title" id="out-h">What happened to each booking</h2><div class="outcomes"></div><p class="note coverage"></p></section>
      <section class="panel-section inspector" aria-labelledby="ins-h" aria-live="polite"><h2 class="section-title" id="ins-h">Inspector</h2><div class="inspector-body"></div></section>
      <section class="panel-section charts" aria-labelledby="ch-h"><h2 class="section-title" id="ch-h">Through the day</h2></section>
      <section class="panel-section" aria-labelledby="log-h"><h2 class="section-title" id="log-h">Dispatch log</h2><ul class="log"></ul></section>`;
    this.kpis = host.querySelector('.kpis')!;
    this.outcomes = host.querySelector('.outcomes')!;
    this.inspector = host.querySelector('.inspector-body')!;
    this.coverageEl = host.querySelector('.coverage')!;
    this.logEl = host.querySelector('.log')!;
    const charts = host.querySelector('.charts')!;
    const fx = (t: number) => clock(t / 3600);
    this.chartRiders = new LineChart({ title: 'Riders waiting vs. on board', fmtY: (v) => num(v, 0), fmtX: fx, yMin: 0 });
    this.chartFleet = new LineChart({ title: 'What the buses are doing', fmtY: (v) => num(v, 0), fmtX: fx, yMin: 0 });
    this.chartWait = new LineChart({ title: 'Average wait for pickup, last 30 min (min)', fmtY: (v) => num(v, v < 10 ? 1 : 0), fmtX: fx, yMin: 0 });
    charts.append(this.chartRiders.el, this.chartFleet.el, this.chartWait.el);
    this.logEl.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (!li) return;
      if (li.dataset.rider) this.onPick?.({ kind: 'rider', id: Number(li.dataset.rider) });
      else if (li.dataset.bus) this.onPick?.({ kind: 'bus', id: Number(li.dataset.bus) });
    });
  }

  reset() {
    this.lastSeries = -1;
    this.lastLog = -1;
    this.logEl.innerHTML = '';
  }

  update(sim: Simulation, sel: Selection) {
    const hours = Math.max(1 / 60, sim.hour - sim.cfg.serviceStart);
    const s = summarize(sim.cfg, sim.stats, Math.min(hours, sim.cfg.serviceEnd - sim.cfg.serviceStart));
    const evs = sim.buses.filter((b) => b.ev).length;
    const tile = (label: string, value: string, sub: string, bad = false) =>
      `<div class="kpi"><span class="kpi-label">${label}</span><span class="kpi-value${bad ? ' bad' : ''}">${value}</span><span class="kpi-sub">${sub}</span></div>`;
    this.kpis.innerHTML = [
      tile('Riders picked up', pct(s.serviceRate), `${s.pickedUp.toLocaleString()} of ${(s.requested - s.noShows - s.rejectedWalk).toLocaleString()} in walking reach`, s.serviceRate < 0.8),
      tile('Wait for pickup', isFinite(s.avgWait) ? `${num(s.avgWait)} min` : '–', `90% within ${num(s.p90Wait)} min`),
      tile('Walking', isFinite(s.avgWalk) ? `${Math.round(s.avgWalk)} m` : '–', `to + from the bus · ${pct(s.reachRate)} of bookings in reach`, s.reachRate < 0.8),
      tile('Ride', isFinite(s.avgRide) ? `${num(s.avgRide)} min` : '–', isFinite(s.avgDetour) ? `${num(s.avgDetour, 2)}× the direct ride` : 'no trips finished yet'),
      tile('Riders per bus', num(s.avgLoad), `when carrying · ${pct(s.occupancy)} of seat-km used`),
      tile('Fleet busy', pct(s.utilisation), `${num(s.ridesPerBusHour)} rides / bus-hour · ${pct(s.emptyKmShare)} empty km`),
      tile('Profit / hour', naira(s.profitPerHour), `revenue ${naira(s.revenue)} · costs ${naira(s.fuelCost + s.electricityCost + s.busCost)}`, s.profitPerHour < 0),
      tile('Break-even fare', naira(s.breakEvenFare), `cost per ride at this demand`),
      tile('CO₂ per ride', isFinite(s.co2PerRide) ? `${num(s.co2PerRide, 2)} kg` : '–', `${num(s.co2Kg, 0)} kg today · energy ${naira(s.pickedUp ? (s.fuelCost + s.electricityCost) / s.pickedUp : NaN)}/ride`),
      evs
        ? tile('Charging', pct(s.chargingShare), `of bus-hours · ${s.chargeVisits} charges · ${sim.chargersInUse}/${sim.cfg.chargers} chargers busy${s.flatBatteries ? ` · ${s.flatBatteries} ran flat` : ''}`, s.chargingShare > 0.2 || s.flatBatteries > 0)
        : tile('Fuel', `${num(s.km / 8, 0)} L`, `about 8 km/L · ${naira(s.fuelCost)} today`),
    ].join('');

    // outcomes
    let inProgress = 0;
    for (let i = sim.riders.length - 1; i >= 0; i--) {
      const st = sim.riders[i].state;
      if (st === 'searching' || st === 'assigned' || st === 'onboard') inProgress++;
      if (sim.now - sim.riders[i].requestTime > 6 * 3600) break;
    }
    const parts = [
      { label: 'Arrived', v: s.served, c: '--s1' },
      { label: 'In progress', v: inProgress, c: '--s3' },
      { label: 'No bus in time', v: s.rejectedNoBus, c: '--s2' },
      { label: 'Too far to walk', v: s.rejectedWalk, c: '--s4' },
      { label: 'Cancelled', v: s.cancelled, c: '--s5' },
      { label: 'No-show', v: s.noShows, c: '--s7' },
    ];
    const total = Math.max(1, parts.reduce((a, p) => a + p.v, 0));
    this.outcomes.innerHTML = `<div class="outcome-bar" role="img" aria-label="${parts.map((p) => `${p.label} ${p.v}`).join(', ')}">${parts
      .filter((p) => p.v > 0)
      .map((p) => `<span style="flex:${p.v / total};background:var(${p.c})" title="${p.label}: ${p.v}"></span>`)
      .join('')}</div><div class="outcome-legend">${parts.map((p) => `<div><i style="background:var(${p.c})"></i>${p.label}<b>${p.v.toLocaleString()}</b></div>`).join('')}</div>`;

    this.coverageEl.textContent = `${pct(this.coverage)} of homes in Phase 1 have a meetup point within ${sim.cfg.maxWalk} m. Riders farther away can't book — add bus streets or allow a longer walk.`;

    if (sim.series.length !== this.lastSeries) {
      this.lastSeries = sim.series.length;
      const xs = sim.series.map((p) => p.t);
      this.chartRiders.setData(xs, [
        { name: 'On board', color: '--s1', values: sim.series.map((p) => p.riding) },
        { name: 'Waiting / walking', color: '--s2', values: sim.series.map((p) => p.waiting) },
      ]);
      this.chartFleet.setData(xs, [
        { name: 'Carrying riders', color: '--s1', values: sim.series.map((p) => p.busesCarrying) },
        { name: 'Going to a pickup', color: '--s2', values: sim.series.map((p) => p.busesToPickup) },
        { name: 'Empty / cruising', color: '--s3', values: sim.series.map((p) => p.busesIdle) },
        ...(sim.buses.some((b) => b.ev) ? [{ name: 'Charging', color: '--s4', values: sim.series.map((p) => p.busesCharging) }] : []),
      ]);
      this.chartWait.setData(xs, [{ name: 'Average wait', color: '--s1', values: sim.series.map((p) => p.avgWait) }]);
    }

    this.renderInspector(sim, sel);
    this.renderLog(sim);
  }

  private renderInspector(sim: Simulation, sel: Selection) {
    if (!sel) {
      this.inspector.innerHTML = `<p class="empty">Click a bus or a rider on the map, or an entry in the log, to see their plan.</p>`;
      return;
    }
    const now = sim.now;
    if (sel.kind === 'bus') {
      const b = sim.buses[sel.id];
      const status = {
        idle: 'Cruising empty',
        toPickup: 'Going to a pickup',
        carrying: 'Carrying riders',
        charging: b.charge === 'charging' ? 'Charging' : b.charge === 'queued' ? 'Waiting for a charger' : 'Heading to charge',
        offDuty: 'Off duty',
      }[sim.status(b)];
      const socPct = b.ev ? b.soc / sim.cfg.batteryKWh : 0;
      const energyRows = b.ev
        ? `<dt>Battery</dt><dd><span class="battery" style="--soc:${Math.round(socPct * 100)}%"><i></i></span> ${Math.round(socPct * 100)}% · ${num(b.soc / sim.cfg.evKWhPerKm, 0)} km left</dd>
           <dt>Energy used</dt><dd>${num(b.kwh)} kWh · charged ${fmtMin(b.chargeSec)}</dd>`
        : `<dt>Fuel used</dt><dd>${num(b.km / 8)} L</dd>`;
      const travel = sim.travelFn();
      const st = sim.busState(b);
      let t = st.startTime;
      let at = st.startNode;
      const etas = b.stops.map((s) => {
        if (s.node !== at) t += travel(at, s.node) + sim.cfg.stopDwellSec;
        at = s.node;
        t += sim.cfg.boardSec;
        return t;
      });
      const street = (n: number) => {
        const w = sim.net.wayAt(sim.net.x[n], sim.net.y[n], 5);
        return w >= 0 && sim.net.ways[w].name ? sim.net.ways[w].name : 'meetup point';
      };
      this.inspector.innerHTML = `
        <h3>Bus ${b.id + 1} <span class="state-chip">${b.ev ? 'Electric' : 'Petrol'}</span> <span class="state-chip">${status}</span></h3>
        <div class="seats" aria-label="${b.onboard.length} of ${sim.cfg.seatsPerBus} seats taken">${Array.from({ length: sim.cfg.seatsPerBus }, (_, i) => `<i class="${i < b.onboard.length ? 'taken' : ''}"></i>`).join('')}</div>
        <dl>
          <dt>Seats taken</dt><dd>${b.onboard.length} / ${sim.cfg.seatsPerBus}</dd>
          <dt>Trips completed</dt><dd>${b.trips}</dd>
          <dt>Distance today</dt><dd>${num(b.km)} km (${pct(b.km ? 1 - b.kmLoaded / b.km : 0)} empty)</dd>
          <dt>Busy</dt><dd>${pct(b.serviceSec ? b.busySec / b.serviceSec : 0)} of the time</dd>
          ${energyRows}
        </dl>
        ${b.stops.length ? `<ol class="stops" aria-label="Planned stops">${b.stops
          .map((s, i) => `<li><span class="stop-n${s.kind === 'dropoff' ? ' drop' : ''}">${i + 1}</span><span>${s.kind === 'pickup' ? 'Pick up' : 'Drop off'} #${s.rider} · ${street(s.node)}</span><span class="muted">${clock(etas[i] / 3600)}</span></li>`)
          .join('')}</ol>` : `<p class="empty">${b.charge !== 'none' ? 'Not taking bookings until charged.' : `No bookings — ${sim.cfg.idleBehaviour === 'park' ? 'parked' : 'cruising the corridors'}.`}</p>`}`;
      return;
    }
    const r = sim.riders[sel.id];
    const wait = r.pickupTime >= 0 ? r.pickupTime - r.requestTime : now - r.requestTime;
    const rows: [string, string][] = [
      ['From', r.from.label],
      ['To', r.to.label],
      ['Booked at', clock(r.requestTime / 3600)],
    ];
    if (r.busId >= 0) rows.push(['Bus', `Bus ${r.busId + 1}`]);
    if (r.pickupNode >= 0) {
      rows.push(['Walk to meetup', `${Math.round(r.walkIn)} m (${fmtMin(r.walkIn / sim.cfg.walkSpeed)})`]);
      rows.push(['Promised pickup', clock(r.promisedPickup / 3600)]);
    }
    if (r.state === 'assigned' || r.state === 'searching') rows.push(['Waiting for', fmtMin(wait)]);
    if (r.pickupTime >= 0) rows.push(['Picked up', `${clock(r.pickupTime / 3600)} (waited ${fmtMin(wait)})`]);
    if (r.dropoffTime >= 0) rows.push(['Arrived', `${clock(r.dropoffTime / 3600)} (ride ${fmtMin(r.dropoffTime - r.pickupTime)})`]);
    else if (r.state === 'onboard') rows.push(['Expected drop-off', clock(r.promisedDropoff / 3600)]);
    if (r.pickupNode >= 0) rows.push(['Walk from drop-off', `${Math.round(r.walkOut)} m`]);
    if (r.fare) rows.push(['Fare', naira(r.fare)]);
    if (r.reason) rows.push(['Why', r.reason]);
    this.inspector.innerHTML = `<h3>Rider #${r.id}${r.manual ? ' (you)' : ''} <span class="state-chip">${STATE_LABEL[r.state]}</span></h3>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
  }

  private renderLog(sim: Simulation) {
    const last = sim.log.length ? sim.log[sim.log.length - 1] : null;
    const key = last ? last.t * 1000 + sim.log.length : -1;
    if (key === this.lastLog) return;
    this.lastLog = key;
    const items = sim.log.slice(-60).reverse();
    this.logEl.innerHTML = items
      .map((e) => `<li class="k-${e.kind}"${e.rider !== undefined ? ` data-rider="${e.rider}"` : e.bus !== undefined ? ` data-bus="${e.bus}"` : ''}><time>${clock(e.t / 3600)}</time><span>${escapeHtml(e.text)}</span></li>`)
      .join('');
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
