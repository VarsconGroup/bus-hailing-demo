import './styles.css';
import raw from './data/lekki-network.json';
import { clock, DEFAULT_CONFIG, type SimConfig } from './sim/config';
import { Rng } from './sim/rng';
import { Network, type RawNetwork } from './sim/network';
import { fmtMin, Simulation } from './sim/simulation';
import type { StreetState } from './sim/sweep';
import { buildControls } from './ui/controls';
import { Dashboard, escapeHtml } from './ui/dashboard';
import { describe, MapView, type Tool } from './ui/mapView';
import { SweepPanel } from './ui/sweepPanel';

const data = raw as unknown as RawNetwork;

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 1 1-4.6 3H1.2A7 7 0 1 0 3 3.4V1.5L.8 4.2 3.6 6V4.7A5 5 0 0 1 8 3z" fill="currentColor"/></svg>',
  select: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5l9.5 6.2-4.3.8 2.4 4.6-1.8.9-2.4-4.6-3.4 2.9z" fill="currentColor"/></svg>',
  book: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a4.5 4.5 0 0 0-4.5 4.5C3.5 9 8 15 8 15s4.5-6 4.5-9.5A4.5 4.5 0 0 0 8 1zm0 6.3a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z" fill="currentColor"/></svg>',
  bus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5V11a1 1 0 0 1-1 1h-.3a1.7 1.7 0 0 1-3.4 0H6.7a1.7 1.7 0 0 1-3.4 0H3a1 1 0 0 1-1-1zM3.5 4v3.5h9V4z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 6h14v4H1z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 6l4 4M7 6l4 4M11 6l4 4" stroke="currentColor" stroke-width="1.5"/><path d="M3 10v4M13 10v4" stroke="currentColor" stroke-width="1.5"/></svg>',
  hub: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1L3 9h4.5l-1 6L13 7H8.5z" fill="currentColor"/></svg>',
  jam: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 1.5h3l3.5 12h-10z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5 9h6" stroke="currentColor" stroke-width="1.5"/><path d="M1 14.5h14" stroke="currentColor" stroke-width="1.5"/></svg>',
};

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Inspect', hint: 'Click a bus or rider to see their plan. Drag to pan, scroll or pinch to zoom.' },
  { id: 'book', label: 'Book a ride', hint: 'Click where you are, then where you are going. The dashed circle is your walking range.' },
  { id: 'bus', label: 'Bus streets', hint: 'Click a street to allow or ban buses on it. Blue centre line = bus street. Meetup points update.' },
  { id: 'close', label: 'Close road', hint: 'Click a street to close it (roadworks, flooding, an event). Click again to reopen.' },
  { id: 'jam', label: 'Traffic jam', hint: 'Click a street to slow it to 20% speed. Click again to clear the jam.' },
  { id: 'hub', label: 'Charging hub', hint: 'Click where the charging hub should go. Electric buses drive there to charge; it snaps to the nearest meetup point.' },
];
const SPEEDS = [1, 10, 30, 60, 180, 600];

// ------------------------------------------------------------------ DOM

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span><div><h1>Lekki Bus-Hailing Simulator</h1><p>Phase 1 pilot · on-demand minibuses on real OpenStreetMap streets</p></div></div>
    <div class="clock"><span class="clock-time" id="clock">06:00</span><span class="pill" id="service-pill">In service</span></div>
    <div class="transport">
      <button class="btn primary" id="play" type="button"></button>
      <div class="seg" role="group" aria-label="Simulation speed" id="speeds">${SPEEDS.map((s) => `<button type="button" data-speed="${s}" aria-pressed="false" title="${s} simulated seconds per second">${s}×</button>`).join('')}</div>
      <button class="btn" id="restart" type="button" title="Start the day again with the same settings">${ICON.restart}<span>Restart day</span></button>
    </div>
  </header>
  <main class="layout">
    <aside class="panel left" aria-label="Settings and scenario comparison">
      <div class="tabs" role="tablist">
        <button role="tab" id="tab-settings" aria-selected="true" aria-controls="pane-settings">Settings</button>
        <button role="tab" id="tab-compare" aria-selected="false" aria-controls="pane-compare">Compare scenarios</button>
      </div>
      <div id="pane-settings" role="tabpanel" aria-labelledby="tab-settings"></div>
      <div id="pane-compare" role="tabpanel" aria-labelledby="tab-compare" hidden></div>
    </aside>
    <section class="map-wrap" aria-label="Map">
      <div class="toolbar" role="toolbar" aria-label="Map tools">
        ${TOOLS.map((t) => `<button class="tool" type="button" data-tool="${t.id}" aria-pressed="${t.id === 'select'}" title="${t.label}">${ICON[t.id]}<span>${t.label}</span></button>`).join('')}
        <span class="spacer"></span>
        <label class="toggle"><input type="checkbox" id="show-meetups" checked> Meetup points</label>
        <label class="toggle"><input type="checkbox" id="show-labels" checked> Names</label>
      </div>
      <div class="map-host" id="map-host" data-tool="select">
        <div class="hint" id="hint"></div>
        <div class="zoom"><button type="button" id="zoom-in" aria-label="Zoom in">+</button><button type="button" id="zoom-out" aria-label="Zoom out">−</button><button type="button" id="zoom-fit" aria-label="Fit the pilot zone" title="Fit the pilot zone">⤢</button></div>
        <details class="legend-box" id="legend">
          <summary>Key</summary>
          <div class="legend-grid">
            <svg viewBox="0 0 26 14"><rect x="3" y="3" width="20" height="9" rx="2" fill="var(--danfo)" stroke="var(--danfo-ink)" stroke-width="1.5"/><rect x="5" y="5" width="9" height="5" fill="var(--danfo-ink)"/></svg><span>Petrol bus with riders (dark bar = seats taken)</span>
            <svg viewBox="0 0 26 14"><rect x="3" y="2" width="20" height="8" rx="2" fill="var(--ev)" stroke="var(--ev-ink)" stroke-width="1.5"/><rect x="3" y="11" width="14" height="3" fill="var(--ev)"/></svg><span>Electric bus (bar below = battery)</span>
            <svg viewBox="0 0 26 14"><rect x="3" y="3" width="20" height="9" rx="2" fill="var(--panel)" stroke="var(--danfo-ink)" stroke-width="1.5"/></svg><span>Empty or charging bus</span>
            <svg viewBox="0 0 26 14"><rect x="7" y="1" width="12" height="12" rx="3" fill="var(--ev)" stroke="var(--ev-ink)"/><path d="M14 3l-4 5h3l-1 4 4-5h-3z" fill="var(--ev-ink)"/></svg><span>Charging hub</span>
            <svg viewBox="0 0 26 14"><circle cx="13" cy="7" r="4" fill="var(--s7)" stroke="var(--panel)" stroke-width="1.5"/></svg><span>Rider walking to / waiting at meetup</span>
            <svg viewBox="0 0 26 14"><circle cx="13" cy="7" r="4" fill="var(--s8)"/></svg><span>Rider still looking for a bus</span>
            <svg viewBox="0 0 26 14"><path d="M1 7h24" stroke="var(--road-edge)" stroke-width="7"/><path d="M1 7h24" stroke="var(--road)" stroke-width="5"/><path d="M1 7h24" stroke="var(--bus-road)" stroke-width="2"/><circle cx="13" cy="7" r="3.5" fill="var(--panel)" stroke="var(--bus-road)" stroke-width="1.5"/></svg><span>Bus street with meetup point</span>
            <svg viewBox="0 0 26 14"><path d="M1 7h24" stroke="var(--s8)" stroke-width="3" stroke-dasharray="5 4"/></svg><span>Closed road</span>
            <svg viewBox="0 0 26 14"><path d="M1 7h24" stroke="var(--s2)" stroke-width="6"/></svg><span>Traffic jam</span>
            <svg viewBox="0 0 26 14"><path d="M13 1l6 6-6 6-6-6z" fill="var(--ink)"/></svg><span>Edge gate (toll gate, bridge, junctions)</span>
          </div>
        </details>
        <div class="attribution">Streets © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · demand figures are assumptions</div>
        <div class="toast" id="toast" role="status" hidden></div>
      </div>
    </section>
    <aside class="panel right" id="dash" aria-label="Results"></aside>
  </main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

let cfg: SimConfig = { ...DEFAULT_CONFIG };
const net = new Network(data, cfg.meetupSpacing);
let sim: Simulation;
let playing = true;
let speed = 30;
let acc = 0;
let toastTimer = 0;

const map = new MapView($('map-host'));
const dash = new Dashboard($('dash'));
const refreshControls = buildControls($('pane-settings'), () => cfg, onConfig);
new SweepPanel($('pane-compare'), () => cfg, streetState);

function streetState(): StreetState {
  return { bus: net.ways.map((w) => w.bus), closed: net.ways.map((w) => w.closed), jam: net.ways.map((w) => w.jam) };
}

/** Share of homes with a meetup point within walking range (sampled). */
function computeCoverage() {
  const rng = new Rng(7);
  let ok = 0;
  const N = 1500;
  for (let i = 0; i < N; i++) {
    const h = sim.demand.home(rng);
    if (net.meetupsNear(h.x, h.y, cfg.maxWalk, 1).length) ok++;
  }
  dash.coverage = ok / N;
}

function newDay(warmup = 0) {
  sim = new Simulation(data, cfg, net);
  map.sim = sim;
  map.selection = null;
  dash.reset();
  if (warmup) sim.advance(warmup);
  computeCoverage();
  map.fit();
  hideToast();
  const hubBtn = document.querySelector<HTMLButtonElement>('.tool[data-tool="hub"]')!;
  hubBtn.hidden = cfg.powertrain === 'fuel';
  if (hubBtn.hidden && map.tool === 'hub') setTool('select');
}

function onConfig(patch: Partial<SimConfig>, restart: boolean) {
  cfg = { ...cfg, ...patch };
  if (restart) newDay();
  else {
    sim.setConfig(patch);
    if (patch.maxWalk !== undefined || patch.meetupSpacing !== undefined) computeCoverage();
  }
  refreshControls();
}

// ------------------------------------------------------------------ top bar

function setPlaying(p: boolean) {
  playing = p;
  $('play').innerHTML = p ? `${ICON.pause}<span>Pause</span>` : `${ICON.play}<span>Play</span>`;
}
$('play').addEventListener('click', () => {
  if (sim.finished) newDay();
  setPlaying(!playing);
});
$('restart').addEventListener('click', () => {
  newDay();
  setPlaying(true);
});
function setSpeed(s: number) {
  speed = s;
  for (const b of $('speeds').querySelectorAll('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s));
}
$('speeds').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) setSpeed(Number(b.dataset.speed));
});

// tabs
for (const [tab, pane, other, otherPane] of [
  ['tab-settings', 'pane-settings', 'tab-compare', 'pane-compare'],
  ['tab-compare', 'pane-compare', 'tab-settings', 'pane-settings'],
])
  $(tab).addEventListener('click', () => {
    $(tab).setAttribute('aria-selected', 'true');
    $(other).setAttribute('aria-selected', 'false');
    $(pane).hidden = false;
    $(otherPane).hidden = true;
  });

// ------------------------------------------------------------------ map tools

function setTool(t: Tool) {
  map.tool = t;
  map.bookStart = null;
  $('map-host').dataset.tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  setHint(TOOLS.find((x) => x.id === t)!.hint);
}
function setHint(text: string) {
  $('hint').textContent = text;
  $('hint').hidden = !text;
}
document.querySelector('.toolbar')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.tool');
  if (b) setTool(b.dataset.tool as Tool);
});
$<HTMLInputElement>('show-meetups').addEventListener('change', (e) => (map.showMeetups = (e.target as HTMLInputElement).checked));
$<HTMLInputElement>('show-labels').addEventListener('change', (e) => (map.showLabels = (e.target as HTMLInputElement).checked));
$('zoom-in').addEventListener('click', () => map.zoomBy(1.3));
$('zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.3));
$('zoom-fit').addEventListener('click', () => map.fit());

map.onHint = setHint;
dash.onPick = (s) => {
  map.selection = s;
};
map.onStreet = (tool, way) => {
  if (tool === 'bus') sim.toggleBusStreet(way);
  else if (tool === 'close') sim.toggleClosed(way);
  else if (tool === 'jam') sim.toggleJam(way);
  const w = net.ways[way];
  const what = tool === 'bus' ? (w.bus ? 'now a bus street' : 'no longer a bus street') : tool === 'close' ? (w.closed ? 'closed' : 'reopened') : w.jam < 1 ? 'jammed' : 'clear again';
  showToast(`${escapeHtml(w.name || 'Unnamed street')} is ${what}`, tool === 'bus' ? `${net.meetups.length} meetup points on ${net.stats().busKm.toFixed(1)} km of bus streets.` : 'Buses re-route at their next junction.');
  computeCoverage();
};
map.onHub = (x, y) => {
  sim.setHub(x, y);
  cfg = { ...cfg, hubX: x, hubY: y };
  showToast('Charging hub moved', `Now at ${escapeHtml(describe(sim, net.x[sim.hubNode], net.y[sim.hubNode]))}. Buses already charging drive over to it.`);
};
map.onBook = (from, to) => {
  const r = sim.book(from, to, { manual: true });
  map.selection = { kind: 'rider', id: r.id };
  setHint(TOOLS[1].hint);
  if (r.state === 'rejected') showToast('Can’t book this ride', escapeHtml(r.reason));
  else if (r.state === 'assigned')
    showToast(
      `Bus ${r.busId + 1} is coming`,
      `Walk ${Math.round(r.walkIn)} m to the meetup point (${fmtMin(r.walkIn / cfg.walkSpeed)}). Pickup around ${clock(r.promisedPickup / 3600)}, in ${fmtMin(r.promisedPickup - sim.now)}. Fare ₦${r.fare.toLocaleString('en-NG')}.`,
    );
  else showToast('Looking for a bus…', 'Every bus that could reach you in time is full or too far. The app keeps trying until your patience runs out.');
};

function showToast(title: string, body: string) {
  const t = $('toast');
  t.innerHTML = `<h3>${title}</h3><div>${body}</div>`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 7000);
}
function hideToast() {
  $('toast').hidden = true;
}

// ------------------------------------------------------------------ loop

let last = performance.now();
let lastDash = 0;
let wasFinished = false;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing && !sim.finished) {
    acc += dt * speed;
    const steps = Math.min(Math.floor(acc), 3000);
    acc -= steps;
    if (acc > 3000) acc = 0; // can't keep up at this speed; drop the backlog
    sim.advance(steps);
  }
  map.draw();
  $('clock').textContent = clock((sim.now / 3600) % 24);
  const pill = $('service-pill');
  pill.textContent = sim.inService ? 'In service' : sim.finished ? 'Day complete' : sim.hour < cfg.serviceStart ? 'Before service' : 'Finishing trips';
  pill.classList.toggle('on', sim.inService);
  if (now - lastDash > 250) {
    lastDash = now;
    dash.update(sim, map.selection);
  }
  if (sim.finished && !wasFinished) {
    setPlaying(false);
    showToast('Day complete', `Service ended at ${clock(cfg.serviceEnd)} and every rider is home. Check the totals on the right, or try the Compare scenarios tab.`);
  }
  wasFinished = sim.finished;
  requestAnimationFrame(frame);
}

($('legend') as HTMLDetailsElement).open = window.innerWidth > 900 && window.innerHeight > 760;

// Open on a running morning so there is something to see straight away.
newDay(75 * 60);
refreshControls();
setPlaying(true);
setSpeed(speed);
setTool('select');
requestAnimationFrame(frame);
