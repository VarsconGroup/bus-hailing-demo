// Settings panel built from PARAM_GROUPS.
import { PARAM_GROUPS, type ParamSpec, type SimConfig } from '../sim/config';

export function buildControls(
  host: HTMLElement,
  getCfg: () => SimConfig,
  onChange: (patch: Partial<SimConfig>, restart: boolean) => void,
) {
  const refreshers: (() => void)[] = [];
  PARAM_GROUPS.forEach((g, gi) => {
    const det = document.createElement('details');
    det.className = 'group';
    det.open = gi < 4;
    const sum = document.createElement('summary');
    sum.textContent = g.title;
    const body = document.createElement('div');
    body.className = 'group-body';
    det.append(sum, body);
    for (const p of g.params) {
      const { el, refresh } = field(p, getCfg, onChange);
      body.append(el);
      refreshers.push(refresh);
    }
    host.append(det);
  });
  return () => refreshers.forEach((r) => r());
}

function field(p: ParamSpec, getCfg: () => SimConfig, onChange: (patch: Partial<SimConfig>, restart: boolean) => void) {
  const el = document.createElement('div');
  el.className = 'field';
  const id = `cfg-${p.key}`;
  const tag = p.restart ? '<span class="restart-tag" title="Changing this restarts the day">restarts</span>' : '';
  const help = `<small id="${id}-help">${p.help}</small>`;
  let refresh: () => void;
  if (p.kind === 'number') {
    el.innerHTML = `<div class="field-head"><label for="${id}">${p.label}${tag}</label><output for="${id}" id="${id}-out"></output></div>
      <input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}" aria-describedby="${id}-help">${help}`;
    const input = el.querySelector('input')!;
    const out = el.querySelector('output')!;
    const fmt = (v: number) => (p.format ? p.format(v) : `${v.toLocaleString('en-NG')}${p.unit ? ` ${p.unit}` : ''}`);
    input.addEventListener('input', () => {
      out.textContent = fmt(Number(input.value));
      if (!p.restart) onChange({ [p.key]: Number(input.value) } as Partial<SimConfig>, false);
    });
    // Restart-type sliders apply when released so dragging doesn't restart the day repeatedly.
    input.addEventListener('change', () => {
      if (p.restart) onChange({ [p.key]: Number(input.value) } as Partial<SimConfig>, true);
    });
    refresh = () => {
      const v = getCfg()[p.key] as number;
      input.value = String(v);
      out.textContent = fmt(v);
      el.hidden = p.showIf ? !p.showIf(getCfg()) : false;
    };
  } else if (p.kind === 'select') {
    el.innerHTML = `<div class="field-head"><label for="${id}">${p.label}${tag}</label></div>
      <select id="${id}" aria-describedby="${id}-help">${p.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}</select>${help}`;
    const sel = el.querySelector('select')!;
    sel.addEventListener('change', () => onChange({ [p.key]: sel.value } as Partial<SimConfig>, !!p.restart));
    refresh = () => {
      sel.value = String(getCfg()[p.key]);
      el.hidden = p.showIf ? !p.showIf(getCfg()) : false;
    };
  } else {
    el.innerHTML = `<label class="check"><input type="checkbox" id="${id}" aria-describedby="${id}-help"><span>${p.label}${tag}<br>${help}</span></label>`;
    const cb = el.querySelector('input')!;
    cb.addEventListener('change', () => onChange({ [p.key]: cb.checked } as Partial<SimConfig>, !!p.restart));
    refresh = () => {
      cb.checked = Boolean(getCfg()[p.key]);
      el.hidden = p.showIf ? !p.showIf(getCfg()) : false;
    };
  }
  refresh();
  return { el, refresh };
}
