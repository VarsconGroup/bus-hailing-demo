// Minimal canvas line chart: one y-axis, 2px lines, faint grid, legend + end labels,
// crosshair tooltip on hover. Colours come from CSS custom properties so both themes work.

export interface Series {
  name: string;
  color: string; // CSS var name, e.g. '--s1'
  values: number[];
}

export interface ChartOptions {
  title: string;
  /** format a y value for axis ticks and tooltips */
  fmtY: (v: number) => string;
  /** format an x value */
  fmtX: (v: number) => string;
  yMin?: number;
  /** draw points (for sweeps with few x values) */
  dots?: boolean;
  /** highlight one x value (e.g. the current setting in a sweep) */
  markX?: number;
}

export class LineChart {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tip: HTMLDivElement;
  private legend: HTMLDivElement;
  private x: number[] = [];
  private series: Series[] = [];
  private hover = -1;
  private table: HTMLTableElement;

  constructor(private opts: ChartOptions) {
    this.el = document.createElement('figure');
    this.el.className = 'chart';
    const head = document.createElement('figcaption');
    head.innerHTML = `<span class="chart-title"></span>`;
    head.querySelector('.chart-title')!.textContent = opts.title;
    const tbtn = document.createElement('button');
    tbtn.className = 'link-btn';
    tbtn.type = 'button';
    tbtn.textContent = 'Table';
    tbtn.setAttribute('aria-pressed', 'false');
    head.append(tbtn);
    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    const wrap = document.createElement('div');
    wrap.className = 'chart-plot';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', opts.title);
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    wrap.append(this.canvas, this.tip);
    this.table = document.createElement('table');
    this.table.className = 'chart-table';
    this.table.hidden = true;
    const tableWrap = document.createElement('div');
    tableWrap.className = 'table-scroll';
    tableWrap.append(this.table);
    this.el.append(head, this.legend, wrap, tableWrap);
    tbtn.addEventListener('click', () => {
      this.table.hidden = !this.table.hidden;
      tbtn.setAttribute('aria-pressed', String(!this.table.hidden));
      if (!this.table.hidden) this.renderTable();
    });
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.tip.hidden = true;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(wrap);
  }

  setOptions(o: Partial<ChartOptions>) {
    Object.assign(this.opts, o);
  }

  setData(x: number[], series: Series[]) {
    this.x = x;
    const namesChanged = series.map((s) => s.name).join() !== this.series.map((s) => s.name).join();
    this.series = series;
    if (namesChanged) {
      this.legend.innerHTML = '';
      if (series.length > 1)
        for (const s of series) {
          const item = document.createElement('span');
          item.className = 'legend-item';
          item.innerHTML = `<i style="background:var(${s.color})"></i>`;
          item.append(s.name);
          this.legend.append(item);
        }
    }
    this.draw();
    if (!this.table.hidden) this.renderTable();
  }

  private renderTable() {
    const rows = this.x.map((x, i) => `<tr><th scope="row">${this.opts.fmtX(x)}</th>${this.series.map((s) => `<td>${isFinite(s.values[i]) ? this.opts.fmtY(s.values[i]) : '–'}</td>`).join('')}</tr>`);
    const step = Math.max(1, Math.ceil(rows.length / 60));
    this.table.innerHTML = `<thead><tr><th></th>${this.series.map((s) => `<th scope="col">${s.name}</th>`).join('')}</tr></thead><tbody>${rows.filter((_, i) => i % step === 0 || i === rows.length - 1).join('')}</tbody>`;
  }

  private layout() {
    const w = this.canvas.parentElement!.clientWidth;
    const h = this.canvas.parentElement!.clientHeight || 140;
    return { w, h, l: 40, r: 10, t: 8, b: 20 };
  }

  private yRange() {
    let lo = this.opts.yMin ?? Infinity;
    let hi = -Infinity;
    for (const s of this.series)
      for (const v of s.values)
        if (isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
    if (!isFinite(lo)) lo = 0;
    if (!isFinite(hi) || hi <= lo) hi = lo + 1;
    const step = niceStep((hi - lo) / 4);
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  }

  draw() {
    const { w, h, l, r, t, b } = this.layout();
    if (w <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.el);
    const col = (v: string) => css.getPropertyValue(v).trim() || '#888';
    ctx.clearRect(0, 0, w, h);
    ctx.font = `11px ${col('--font-data')}`;
    const pw = w - l - r;
    const ph = h - t - b;
    if (!this.x.length) {
      ctx.fillStyle = col('--muted');
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for data…', l + pw / 2, t + ph / 2);
      return;
    }
    const x0 = this.x[0];
    const x1 = this.x[this.x.length - 1];
    const sx = (x: number) => l + (x1 === x0 ? pw / 2 : ((x - x0) / (x1 - x0)) * pw);
    const { lo, hi, step } = this.yRange();
    const sy = (v: number) => t + ph - ((v - lo) / (hi - lo)) * ph;

    // grid + y ticks
    ctx.strokeStyle = col('--grid');
    ctx.lineWidth = 1;
    ctx.fillStyle = col('--muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = lo; v <= hi + step / 2; v += step) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(w - r, y);
      ctx.stroke();
      ctx.fillText(this.opts.fmtY(v), l - 6, y);
    }
    // x ticks: ~5 labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const n = this.x.length;
    const every = Math.max(1, Math.ceil(n / 5));
    for (let i = 0; i < n; i += every) ctx.fillText(this.opts.fmtX(this.x[i]), Math.min(w - r - 14, Math.max(l + 14, sx(this.x[i]))), h - b + 5);

    if (this.opts.markX !== undefined && this.opts.markX >= x0 && this.opts.markX <= x1) {
      ctx.strokeStyle = col('--muted');
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx(this.opts.markX), t);
      ctx.lineTo(sx(this.opts.markX), t + ph);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const s of this.series) {
      ctx.strokeStyle = col(s.color);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      s.values.forEach((v, i) => {
        if (!isFinite(v)) {
          pen = false;
          return;
        }
        const X = sx(this.x[i]);
        const Y = sy(v);
        if (pen) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
        pen = true;
      });
      ctx.stroke();
      if (this.opts.dots || n === 1)
        s.values.forEach((v, i) => {
          if (!isFinite(v)) return;
          ctx.beginPath();
          ctx.arc(sx(this.x[i]), sy(v), 4, 0, Math.PI * 2);
          ctx.fillStyle = col(s.color);
          ctx.fill();
          ctx.strokeStyle = col('--panel');
          ctx.lineWidth = 2;
          ctx.stroke();
        });
      // emphasise the latest point
      let last = s.values.length - 1;
      while (last >= 0 && !isFinite(s.values[last])) last--;
      if (last >= 0 && !this.opts.dots) {
        ctx.beginPath();
        ctx.arc(sx(this.x[last]), sy(s.values[last]), 4, 0, Math.PI * 2);
        ctx.fillStyle = col(s.color);
        ctx.fill();
        ctx.strokeStyle = col('--panel');
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    if (this.hover >= 0 && this.hover < n) {
      const X = sx(this.x[this.hover]);
      ctx.strokeStyle = col('--ink');
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X, t);
      ctx.lineTo(X, t + ph);
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const s of this.series) {
        const v = s.values[this.hover];
        if (!isFinite(v)) continue;
        ctx.beginPath();
        ctx.arc(X, sy(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = col(s.color);
        ctx.fill();
        ctx.strokeStyle = col('--panel');
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  private onMove(e: PointerEvent) {
    if (!this.x.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const { w, l, r } = this.layout();
    const px = e.clientX - rect.left;
    const x0 = this.x[0];
    const x1 = this.x[this.x.length - 1];
    const xv = x0 + ((px - l) / (w - l - r)) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < this.x.length; i++) if (Math.abs(this.x[i] - xv) < Math.abs(this.x[best] - xv)) best = i;
    this.hover = best;
    this.tip.hidden = false;
    this.tip.innerHTML = `<b>${this.opts.fmtX(this.x[best])}</b>` + this.series.map((s) => `<div><i style="background:var(${s.color})"></i>${s.name}<span>${isFinite(s.values[best]) ? this.opts.fmtY(s.values[best]) : '–'}</span></div>`).join('');
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.min(w - tw - 4, Math.max(4, px + 12))}px`;
    this.draw();
  }
}

function niceStep(raw: number) {
  if (raw <= 0 || !isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
