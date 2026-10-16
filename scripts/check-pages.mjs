// Page check: opens pages in headless Chrome at phone (390 px) and desktop (1280 px) widths and reports any page that is
// wider than the screen, logs a script error or a Content-Security-Policy violation, or doesn't load. With every
// <details> opened, so hidden panels are checked too.
//
//   node scripts/check-pages.mjs [base-url] [path-list-file]
// The app must be running (npm run dev, DEV_NO_AUTH=1). Without a list it checks every report and the report pages.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPORTS } from '../lib/reports/registry.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const paths = process.argv[3] ? readFileSync(process.argv[3], 'utf8').split(/\r?\n/).filter(Boolean) : [
  '/reports', '/reports/custom', '/reports/management', '/reports/r/kpi_scorecard', '/reports/kpis/new', '/reports/cash-flow', '/reports/cash-flow?weeks=52&trend=1',
  ...['standard', 'profitability', 'cash_flow', 'balance_sheet', 'receivables', 'payables', 'revenue', 'sales'].map(d => `/reports/dashboards?d=${d}`),
  ...REPORTS.map(r => `/reports/r/${r.key}`),
  ...REPORTS.filter(r => ['period', 'cashflow'].includes(r.kind)).map(r => `/reports/r/${r.key}?run=1&period=this_year_to_date&columns=months&cmp_py=1&chg=1`),
];
// Tax Books (T1): /tax and each company's tax setup page, taken from the home page's links (company ids differ per database).
if (!process.argv[3]) {
  paths.push('/tax');
  try {
    const home = await (await fetch(base + '/tax')).text();
    paths.push(...new Set([...home.matchAll(/href="(\/tax\/\d+\/profile)"/g)].map(m => m[1])));
  } catch { /* the app isn't up: the check below reports it */ }
}

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, '--headless=new', '--no-first-run', '--disable-gpu', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fb-check-'))}`, 'about:blank'],
  { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) { console.error('Chrome did not start'); chrome.kill(); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const waiting = new Map(), events = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) events.push(m);
});
const send = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

const problems = [];
let checked = 0;
for (const path of paths) {
  for (const width of [390, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    events.length = 0;
    await send('Page.navigate', { url: base + path });
    for (let i = 0; i < 100 && !events.some(e => e.method === 'Page.loadEventFired'); i++) await sleep(50);
    const { result } = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      document.querySelectorAll('details').forEach(d => { d.open = true; });
      const wide = [...document.querySelectorAll('body *')].filter(el => {
        if (el.closest('.report-wrap, .dash-tabs, .topnav')) return false;
        const r = el.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1;
      }).slice(0, 3).map(el => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
      return { status: document.title, scroll: document.documentElement.scrollWidth, inner: innerWidth, wide };
    })()` });
    const v = result.result.value;
    const errors = events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map(e => (e.params.exceptionDetails?.exception?.description ?? e.params.entry?.text ?? '').split('\n')[0]);
    const out = [];
    if (v.scroll > v.inner + 1) out.push(`page is ${v.scroll}px wide on a ${v.inner}px screen (${v.wide.join(', ')})`);
    if (/Not found|Something went wrong|Not allowed/.test(v.status)) out.push(`shows “${v.status}”`);
    if (errors.length) out.push(`console: ${[...new Set(errors)].join(' | ')}`);
    if (out.length) problems.push(`${path} @${width}: ${out.join('; ')}`);
    checked++;
  }
}
ws.close();
chrome.kill();
console.log(`checked ${checked} page views (${paths.length} pages × phone and desktop)`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('no problems');
