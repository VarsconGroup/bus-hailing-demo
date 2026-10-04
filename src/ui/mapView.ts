// Canvas map of the pilot zone: streets, meetup points, buses and riders.
// Handles pan/zoom (mouse, wheel, touch pinch) and the map tools.
import type { Place } from '../sim/demand';
import type { RoadClass } from '../sim/network';
import type { Bus, Rider, Simulation } from '../sim/simulation';

export type Tool = 'select' | 'book' | 'bus' | 'close' | 'jam';
export type Selection = { kind: 'bus'; id: number } | { kind: 'rider'; id: number } | null;

const ROAD_W: Record<RoadClass, number> = { expressway: 16, arterial: 11, collector: 9, local: 5 };

export class MapView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  sim!: Simulation;
  tool: Tool = 'select';
  selection: Selection = null;
  showMeetups = true;
  showLabels = true;
  /** pending start point while booking a ride */
  bookStart: Place | null = null;
  onSelect?: (s: Selection) => void;
  onBook?: (from: Place, to: Place) => void;
  onStreet?: (tool: Tool, wayId: number) => void;
  onHint?: (text: string) => void;

  // camera: screen = (world - c) * scale + size/2
  private cx = 0;
  private cy = 0;
  private scale = 0.2;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragMoved = 0;
  private pinchDist = 0;
  private hoverWay = -1;
  private mouse: { x: number; y: number } | null = null;
  private colors: Record<string, string> = {};

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Map of Lekki Phase 1 with buses and riders');
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindInput();
    this.readColors();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.readColors());
    new MutationObserver(() => this.readColors()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  readColors() {
    const css = getComputedStyle(this.host);
    for (const k of ['--land', '--outside', '--water', '--road', '--road-edge', '--road-local', '--bus-road', '--meetup', '--ink', '--muted', '--panel', '--danfo', '--danfo-ink', '--s1', '--s2', '--s3', '--s7', '--s8', '--context', '--zone', '--font-data', '--font-label'])
      this.colors[k] = css.getPropertyValue(k).trim();
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    const first = this.w === 0;
    this.w = r.width;
    this.h = r.height;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    if (first && this.sim) this.fit();
  }

  fit() {
    const z = this.sim.net.raw.zone;
    const xs = z.map((p) => p[0]);
    const ys = z.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    this.scale = Math.min(this.w / (maxX - minX), this.h / (maxY - minY)) * 0.95;
  }

  zoomBy(f: number, sx = this.w / 2, sy = this.h / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.max(0.03, Math.min(6, this.scale * f));
    this.cx = wx - (sx - this.w / 2) / this.scale;
    this.cy = wy - (sy - this.h / 2) / this.scale;
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) / this.scale + this.cx, (sy - this.h / 2) / this.scale + this.cy];
  }
  private sx(x: number) {
    return (x - this.cx) * this.scale + this.w / 2;
  }
  private sy(y: number) {
    return (y - this.cy) * this.scale + this.h / 2;
  }

  // ------------------------------------------------------------------ input

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      this.dragMoved = 0;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.mouse = p;
      const prev = this.pointers.get(e.pointerId);
      if (prev) {
        if (this.pointers.size === 1) {
          this.cx -= (p.x - prev.x) / this.scale;
          this.cy -= (p.y - prev.y) / this.scale;
          this.dragMoved += Math.hypot(p.x - prev.x, p.y - prev.y);
        }
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (this.pinchDist > 0) this.zoomBy(d / this.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
          this.pinchDist = d;
          this.dragMoved = 99;
        }
      }
      this.updateHover();
    });
    const up = (e: PointerEvent) => {
      const had = this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (had && this.dragMoved < 6 && this.pointers.size === 0) {
        const r = c.getBoundingClientRect();
        this.click(e.clientX - r.left, e.clientY - r.top);
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.hoverWay = -1;
    });
    c.addEventListener('keydown', (e) => {
      const step = 60 / this.scale;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-') this.zoomBy(0.8);
      else if (e.key === 'ArrowLeft') this.cx -= step;
      else if (e.key === 'ArrowRight') this.cx += step;
      else if (e.key === 'ArrowUp') this.cy -= step;
      else if (e.key === 'ArrowDown') this.cy += step;
      else if (e.key === 'Escape') this.bookStart = null;
      else return;
      e.preventDefault();
    });
  }

  private streetTool() {
    return this.tool === 'bus' || this.tool === 'close' || this.tool === 'jam';
  }

  private updateHover() {
    if (!this.mouse || !this.streetTool()) {
      this.hoverWay = -1;
      return;
    }
    const [x, y] = this.toWorld(this.mouse.x, this.mouse.y);
    this.hoverWay = this.sim.net.wayAt(x, y, 14 / this.scale + 6);
  }

  private click(px: number, py: number) {
    const [x, y] = this.toWorld(px, py);
    if (this.tool === 'book') {
      const p: Place = { x, y, kind: 'home', label: describe(this.sim, x, y) };
      if (!this.bookStart) {
        this.bookStart = p;
        this.onHint?.('Now click the destination.');
      } else {
        const from = this.bookStart;
        this.bookStart = null;
        this.onBook?.(from, { ...p, kind: nearGate(this.sim, x, y) ? 'gate' : 'home' });
      }
      return;
    }
    if (this.streetTool()) {
      const way = this.sim.net.wayAt(x, y, 14 / this.scale + 6);
      if (way >= 0) this.onStreet?.(this.tool, way);
      return;
    }
    // select: nearest bus, then nearest rider marker
    const tol = 14 / this.scale;
    let best: Selection = null;
    let bd = tol;
    for (const b of this.sim.buses) {
      const p = this.sim.busPose(b);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = { kind: 'bus', id: b.id };
      }
    }
    if (!best) {
      bd = tol;
      for (const r of this.visibleRiders()) {
        const p = this.riderPos(r);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) {
          bd = d;
          best = { kind: 'rider', id: r.id };
        }
      }
    }
    this.selection = best;
    this.onSelect?.(best);
  }

  // ------------------------------------------------------------------ drawing

  private *visibleRiders(): Generator<Rider> {
    const rs = this.sim.riders;
    for (let i = rs.length - 1; i >= 0 && i >= rs.length - 3000; i--) {
      const r = rs[i];
      if (r.state === 'searching' || r.state === 'assigned') yield r;
    }
  }

  riderPos(r: Rider): { x: number; y: number } {
    const n = this.sim.net;
    if (r.state === 'onboard' && r.busId >= 0) return this.sim.busPose(this.sim.buses[r.busId]);
    if (r.state === 'assigned' && r.pickupNode >= 0) {
      const walkStart = r.readyTime - r.walkIn / this.sim.cfg.walkSpeed;
      const t = Math.max(0, Math.min(1, (this.sim.now - walkStart) / Math.max(1, r.readyTime - walkStart)));
      return { x: r.from.x + (n.x[r.pickupNode] - r.from.x) * t, y: r.from.y + (n.y[r.pickupNode] - r.from.y) * t };
    }
    if (r.state === 'done' && r.dropoffNode >= 0) return { x: r.to.x, y: r.to.y };
    return { x: r.from.x, y: r.from.y };
  }

  draw() {
    const ctx = this.ctx;
    const C = this.colors;
    const sim = this.sim;
    const net = sim.net;
    const raw = net.raw;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C['--outside'];
    ctx.fillRect(0, 0, this.w, this.h);
    const s = this.scale;
    const poly = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(this.sx(x), this.sy(y)) : ctx.moveTo(this.sx(x), this.sy(y))));
    };

    // pilot zone
    poly(raw.zone);
    ctx.closePath();
    ctx.fillStyle = C['--land'];
    ctx.fill();

    // water
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const w of raw.water) {
      poly(w.pts);
      if (w.kind === 'pond') {
        ctx.fillStyle = C['--water'];
        ctx.fill();
      } else {
        ctx.strokeStyle = C['--water'];
        ctx.lineWidth = w.kind === 'shore' ? Math.max(2, 14 * s) : Math.max(1, 4 * s);
        ctx.stroke();
      }
    }

    // streets outside the zone
    ctx.strokeStyle = C['--context'];
    for (const c of raw.context) {
      ctx.lineWidth = Math.max(0.6, ROAD_W[c.cls] * s * 0.8);
      poly(c.pts);
      ctx.stroke();
    }

    // zone outline
    poly(raw.zone);
    ctx.closePath();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = C['--zone'];
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // streets: casing then fill, lowest class first
    const order: RoadClass[] = ['local', 'collector', 'arterial', 'expressway'];
    const wayPath = (wi: number) => {
      const w = net.ways[wi];
      ctx.beginPath();
      w.nodes.forEach((n, i) => (i ? ctx.lineTo(this.sx(net.x[n]), this.sy(net.y[n])) : ctx.moveTo(this.sx(net.x[n]), this.sy(net.y[n]))));
    };
    for (const cls of order) {
      const wpx = Math.max(cls === 'local' ? 1 : 2, ROAD_W[cls] * s);
      for (const w of net.ways) {
        if (w.cls !== cls) continue;
        wayPath(w.id);
        ctx.strokeStyle = C['--road-edge'];
        ctx.lineWidth = wpx + (cls === 'local' ? 1.5 : 2);
        ctx.stroke();
        wayPath(w.id);
        ctx.strokeStyle = cls === 'local' ? C['--road-local'] : C['--road'];
        ctx.lineWidth = wpx;
        ctx.stroke();
      }
    }
    // bus streets: transit-map centre line; closures and jams on top
    for (const w of net.ways) {
      const wpx = Math.max(2, ROAD_W[w.cls] * s);
      if (w.bus && !w.closed) {
        wayPath(w.id);
        ctx.strokeStyle = C['--bus-road'];
        ctx.lineWidth = Math.max(1.5, wpx * 0.35);
        ctx.stroke();
      }
      if (w.jam < 1) {
        wayPath(w.id);
        ctx.strokeStyle = C['--s2'];
        ctx.lineWidth = wpx + 3;
        ctx.globalAlpha = 0.75;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (w.closed) {
        wayPath(w.id);
        ctx.strokeStyle = C['--s8'];
        ctx.lineWidth = Math.max(2, wpx * 0.6);
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.hoverWay >= 0) {
      wayPath(this.hoverWay);
      ctx.strokeStyle = C['--danfo'];
      ctx.lineWidth = Math.max(4, ROAD_W[net.ways[this.hoverWay].cls] * s + 4);
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // street names
    if (this.showLabels) this.drawStreetLabels();

    // meetup points
    if (this.showMeetups) {
      const r = Math.max(2.5, Math.min(5, 9 * s));
      for (const m of net.meetups) {
        ctx.beginPath();
        ctx.arc(this.sx(net.x[m]), this.sy(net.y[m]), r, 0, Math.PI * 2);
        ctx.fillStyle = C['--panel'];
        ctx.fill();
        ctx.strokeStyle = C['--bus-road'];
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // gates
    ctx.font = `600 11px ${C['--font-label']}`;
    ctx.textBaseline = 'middle';
    for (const g of net.gateNodes) {
      const X = this.sx(g.x);
      const Y = this.sy(g.y);
      ctx.fillStyle = C['--ink'];
      ctx.beginPath();
      ctx.moveTo(X, Y - 7);
      ctx.lineTo(X + 6, Y);
      ctx.lineTo(X, Y + 7);
      ctx.lineTo(X - 6, Y);
      ctx.closePath();
      ctx.fill();
      if (s > 0.12) this.label(g.name.toUpperCase(), X + 10, Y, C['--ink']);
    }

    // hotspots
    if (s > 0.18) {
      ctx.font = `500 10.5px ${C['--font-label']}`;
      for (const h of sim.demand.hotspots.slice(0, s > 0.4 ? 30 : 10)) {
        const X = this.sx(h.x);
        const Y = this.sy(h.y);
        ctx.fillStyle = C['--muted'];
        ctx.beginPath();
        ctx.arc(X, Y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        this.label(h.name, X + 6, Y, C['--muted']);
      }
    }

    // selected bus route
    const sel = this.selection;
    if (sel?.kind === 'bus') this.drawRoute(sim.buses[sel.id]);
    if (sel?.kind === 'rider') {
      const r = sim.riders[sel.id];
      if (r.busId >= 0 && (r.state === 'assigned' || r.state === 'onboard')) this.drawRoute(sim.buses[r.busId], r.id);
    }

    // riders
    const now = sim.now;
    for (const r of this.visibleRiders()) {
      const p = this.riderPos(r);
      const X = this.sx(p.x);
      const Y = this.sy(p.y);
      if (r.state === 'assigned' && r.pickupNode >= 0 && now < r.readyTime) {
        ctx.strokeStyle = C['--s7'];
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(X, Y);
        ctx.lineTo(this.sx(net.x[r.pickupNode]), this.sy(net.y[r.pickupNode]));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      const searching = r.state === 'searching';
      ctx.beginPath();
      ctx.arc(X, Y, searching ? 4.5 : 3.8, 0, Math.PI * 2);
      ctx.fillStyle = searching ? C['--s8'] : C['--s7'];
      ctx.fill();
      ctx.strokeStyle = C['--panel'];
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (searching) {
        const ph = ((now - r.requestTime) % 4) / 4;
        ctx.beginPath();
        ctx.arc(X, Y, 5 + ph * 10, 0, Math.PI * 2);
        ctx.strokeStyle = C['--s8'];
        ctx.globalAlpha = 1 - ph;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (sel?.kind === 'rider' && sel.id === r.id) this.ring(X, Y, 10);
    }
    if (sel?.kind === 'rider') {
      const r = sim.riders[sel.id];
      if (r.state === 'onboard' || r.state === 'done') {
        const p = this.riderPos(r);
        this.ring(this.sx(p.x), this.sy(p.y), 14);
      }
      this.pin(r.to.x, r.to.y, 'B');
    }

    // buses
    for (const b of sim.buses) this.drawBus(b);

    // booking preview
    if (this.tool === 'book' && this.bookStart) {
      this.pin(this.bookStart.x, this.bookStart.y, 'A');
      const near = net.meetupsNear(this.bookStart.x, this.bookStart.y, sim.cfg.maxWalk, 1)[0];
      if (near) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = C['--s7'];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(this.sx(this.bookStart.x), this.sy(this.bookStart.y));
        ctx.lineTo(this.sx(net.x[near.node]), this.sy(net.y[near.node]));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this.tool === 'book' && this.mouse) {
      // walking radius preview around the cursor
      ctx.beginPath();
      ctx.arc(this.mouse.x, this.mouse.y, (sim.cfg.maxWalk / 1.3) * s, 0, Math.PI * 2);
      ctx.strokeStyle = C['--s7'];
      ctx.globalAlpha = 0.4;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  private label(text: string, x: number, y: number, color: string) {
    const ctx = this.ctx;
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.colors['--land'];
    ctx.lineJoin = 'round';
    ctx.textAlign = 'left';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private ring(x: number, y: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = this.colors['--ink'];
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private pin(x: number, y: number, letter: string) {
    const ctx = this.ctx;
    const X = this.sx(x);
    const Y = this.sy(y);
    ctx.beginPath();
    ctx.moveTo(X, Y);
    ctx.lineTo(X - 7, Y - 12);
    ctx.arc(X, Y - 15, 8, Math.PI * 0.8, Math.PI * 0.2);
    ctx.closePath();
    ctx.fillStyle = this.colors['--ink'];
    ctx.fill();
    ctx.fillStyle = this.colors['--panel'];
    ctx.font = `700 10px ${this.colors['--font-label']}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, X, Y - 15);
  }

  private drawStreetLabels() {
    const ctx = this.ctx;
    const net = this.sim.net;
    const s = this.scale;
    if (s < 0.09) return;
    const minCls = s > 0.5 ? 3 : s > 0.25 ? 2 : 1;
    const rank: Record<RoadClass, number> = { expressway: 1, arterial: 1, collector: 2, local: 3 };
    const seen = new Set<string>();
    const boxes: [number, number, number, number][] = [];
    ctx.font = `500 ${s > 0.4 ? 11 : 10}px ${this.colors['--font-label']}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ways = [...net.ways].filter((w) => w.name && rank[w.cls] <= minCls).sort((a, b) => b.length - a.length);
    for (const w of ways) {
      if (seen.has(w.name)) continue;
      // label at the middle of the way
      const a = w.nodes[Math.max(0, Math.floor(w.nodes.length / 2) - 1)];
      const b = w.nodes[Math.min(w.nodes.length - 1, Math.floor(w.nodes.length / 2) + 1)];
      const ax = this.sx(net.x[a]);
      const ay = this.sy(net.y[a]);
      const bx = this.sx(net.x[b]);
      const by = this.sy(net.y[b]);
      const tw = ctx.measureText(w.name).width;
      if (w.length * s < tw + 20) continue;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      if (mx < -50 || my < -50 || mx > this.w + 50 || my > this.h + 50) continue;
      const box: [number, number, number, number] = [mx - tw / 2 - 4, my - 8, mx + tw / 2 + 4, my + 8];
      if (boxes.some((o) => o[0] < box[2] && box[0] < o[2] && o[1] < box[3] && box[1] < o[3])) continue;
      boxes.push(box);
      seen.add(w.name);
      let ang = Math.atan2(by - ay, bx - ax);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(ang);
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.colors['--land'];
      ctx.strokeText(w.name, 0, 0);
      ctx.fillStyle = this.colors['--muted'];
      ctx.fillText(w.name, 0, 0);
      ctx.restore();
    }
  }

  private drawRoute(b: Bus, highlightRider?: number) {
    const ctx = this.ctx;
    const net = this.sim.net;
    const route = this.sim.plannedRoute(b);
    const p = this.sim.busPose(b);
    ctx.beginPath();
    ctx.moveTo(this.sx(p.x), this.sy(p.y));
    for (const n of route) ctx.lineTo(this.sx(net.x[n]), this.sy(net.y[n]));
    ctx.strokeStyle = this.colors['--s1'];
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // numbered stops
    ctx.font = `700 10px ${this.colors['--font-data']}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    b.stops.forEach((st, i) => {
      const X = this.sx(net.x[st.node]);
      const Y = this.sy(net.y[st.node]);
      const mine = highlightRider === undefined || st.rider === highlightRider;
      ctx.globalAlpha = mine ? 1 : 0.45;
      ctx.beginPath();
      if (st.kind === 'pickup') ctx.arc(X, Y, 9, 0, Math.PI * 2);
      else ctx.rect(X - 8, Y - 8, 16, 16);
      ctx.fillStyle = st.kind === 'pickup' ? this.colors['--s1'] : this.colors['--ink'];
      ctx.fill();
      ctx.fillStyle = this.colors['--panel'];
      ctx.fillText(String(i + 1), X, Y + 0.5);
      ctx.globalAlpha = 1;
    });
  }

  private drawBus(b: Bus) {
    const ctx = this.ctx;
    const C = this.colors;
    const pose = this.sim.busPose(b);
    const X = this.sx(pose.x);
    const Y = this.sy(pose.y);
    const L = Math.max(18, 14 * this.scale);
    const W = Math.max(9, 6.5 * this.scale);
    const status = this.sim.status(b);
    const cap = this.sim.cfg.seatsPerBus;
    ctx.save();
    ctx.translate(X, Y);
    ctx.rotate(pose.angle);
    // body
    ctx.beginPath();
    ctx.roundRect(-L / 2, -W / 2, L, W, 2.5);
    ctx.fillStyle = status === 'idle' || status === 'offDuty' ? C['--panel'] : C['--danfo'];
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C['--danfo-ink'];
    ctx.stroke();
    // load bar: share of seats taken
    const load = b.onboard.length / cap;
    if (load > 0) {
      ctx.fillStyle = C['--danfo-ink'];
      ctx.fillRect(-L / 2 + 2, -W / 2 + 2, (L - 4) * Math.min(1, load), W - 4);
    }
    // windscreen
    ctx.fillStyle = C['--danfo-ink'];
    ctx.fillRect(L / 2 - 3, -W / 2 + 1.5, 1.5, W - 3);
    ctx.restore();
    if (this.selection?.kind === 'bus' && this.selection.id === b.id) this.ring(X, Y, L * 0.75);
    if (this.scale > 0.12) {
      ctx.font = `700 10px ${C['--font-data']}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const t = `${b.id + 1}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = C['--land'];
      ctx.strokeText(t, X, Y - W / 2 - 3);
      ctx.fillStyle = C['--ink'];
      ctx.fillText(t, X, Y - W / 2 - 3);
    }
  }
}

function nearGate(sim: Simulation, x: number, y: number) {
  return sim.net.gateNodes.some((g) => Math.hypot(g.x - x, g.y - y) < 150);
}

/** Human description of a clicked point: nearest gate, hotspot or street. */
export function describe(sim: Simulation, x: number, y: number): string {
  for (const g of sim.net.gateNodes) if (Math.hypot(g.x - x, g.y - y) < 150) return g.name;
  for (const h of sim.demand.hotspots) if (Math.hypot(h.x - x, h.y - y) < 120) return h.name;
  const w = sim.net.wayAt(x, y, 120);
  return w >= 0 && sim.net.ways[w].name ? `Near ${sim.net.ways[w].name}` : 'Pinned location';
}
