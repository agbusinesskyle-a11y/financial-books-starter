import { html } from './html.js';
import { formatCents } from '../domain/money.js';

// Server-drawn SVG charts: they work without scripts, scale to a phone, and print cleanly. Values are cents.

const short = (s, n = 42) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const compact = cents => {
  const d = Math.abs(cents) / 100, sign = cents < 0 ? '-' : '';
  return d >= 1e6 ? `${sign}$${(d / 1e6).toFixed(1)}M` : d >= 1e3 ? `${sign}$${(d / 1e3).toFixed(d >= 1e4 ? 0 : 1)}K` : `${sign}$${d.toFixed(0)}`;
};

// Horizontal bars: [{ label, value }].
export function bars(title, items, { total = true } = {}) {
  if (!items.length) return html`<figure class="chart"><figcaption>${title}</figcaption><p class="muted">Nothing in this period.</p></figure>`;
  const max = Math.max(...items.map(x => Math.abs(x.value)), 1);
  const sum = items.reduce((s, x) => s + x.value, 0);
  const rowH = 30;
  return html`<figure class="chart"><figcaption>${title} ${total ? html`<span class="muted">${formatCents(sum)}</span>` : ''}</figcaption>
  <svg viewBox="0 0 300 ${items.length * rowH}" role="img" aria-label="${title}">
    ${items.map((x, i) => {
      const w = Math.max(1, Math.round((Math.abs(x.value) / max) * 210));
      return html`<g transform="translate(0 ${i * rowH})">
      <text x="0" y="11" font-size="10" fill="#1d2733">${short(x.label)}</text>
      <rect x="0" y="15" height="9" rx="2" width="${w}" fill="${x.value < 0 ? '#b3261e' : x.color ?? '#0f5c5c'}"></rect>
      <text x="${w + 4}" y="23" font-size="9" fill="#5f6b7a">${formatCents(x.value)}</text></g>`;
    })}
  </svg></figure>`;
}

// Columns over time with up to three series: labels [..], series [{ name, values: [cents], color }]. kind 'bar' | 'line'.
// Colors come from PALETTE (the CSS has a swatch class for each, as inline styles aren't allowed).
export const PALETTE = { brand: '#0f5c5c', amber: '#c98a00', slate: '#7a8ca3', red: '#b3261e' };
// unit: 'money' (cents), 'percent' (fractions) or 'number'.
export function timeChart(title, labels, series, { kind = 'bar', note = '', unit = 'money' } = {}) {
  const axis = v => (unit === 'percent' ? `${Math.round(v * 100)}%` : unit === 'number' ? (Math.round(v * 10) / 10).toLocaleString('en-US') : compact(v));
  const exact = v => (unit === 'percent' ? `${(v * 100).toFixed(1)}%` : unit === 'number' ? (Math.round(v * 100) / 100).toLocaleString('en-US') : formatCents(v));
  const W = 320, H = 170, padL = 40, padB = 22, padT = 8;
  const all = series.flatMap(s => s.values).filter(v => v !== null && v !== undefined);
  if (!labels.length || !all.length) return html`<figure class="chart"><figcaption>${title}</figcaption><p class="muted">No figures yet.</p></figure>`;
  const max = Math.max(...all, 0), min = Math.min(...all, 0);
  const span = max - min || 1;
  const y = v => padT + (H - padT - padB) * (1 - (v - min) / span);
  const plotW = W - padL - 4, step = plotW / labels.length;
  const zero = y(0);
  const every = Math.ceil(labels.length / 6);
  const groupW = step * 0.8, barW = groupW / series.length;
  return html`<figure class="chart"><figcaption>${title}${note ? html` <span class="muted">${note}</span>` : ''}</figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    <line x1="${padL}" x2="${W - 4}" y1="${zero}" y2="${zero}" stroke="#c4ccd6" stroke-width="1"></line>
    <text x="${padL - 4}" y="${y(max) + 4}" font-size="8" fill="#5f6b7a" text-anchor="end">${axis(max)}</text>
    ${min < 0 ? html`<text x="${padL - 4}" y="${y(min)}" font-size="8" fill="#5f6b7a" text-anchor="end">${axis(min)}</text>` : ''}
    ${labels.map((l, i) => (i % every === 0 ? html`<text x="${padL + i * step + step / 2}" y="${H - 6}" font-size="8" fill="#5f6b7a" text-anchor="middle">${short(l, 9)}</text>` : ''))}
    ${kind === 'bar'
      ? series.map((s, k) => s.values.map((v, i) => (v === null ? '' : html`<rect x="${padL + i * step + (step - groupW) / 2 + k * barW}" y="${Math.min(y(v), zero)}"
          width="${Math.max(1, barW - 1)}" height="${Math.max(1, Math.abs(zero - y(v)))}" fill="${s.color}"><title>${s.name} ${labels[i]}: ${exact(v)}</title></rect>`)))
      : series.map(s => html`<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${s.values.map((v, i) => (v === null ? '' : `${padL + i * step + step / 2},${y(v)}`)).join(' ')}"></polyline>`)}
  </svg>
  ${series.length > 1 ? html`<p class="legend">${series.map(s => html`<span><i class="${`swatch c${s.color.slice(1)}`}"></i>${s.name}</span>`)}</p>` : ''}
  </figure>`;
}
