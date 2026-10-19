import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { ledgerCheck } from '../lib/data/ledger.js';
import { globalSearch } from '../lib/data/search.js';
import { withDisplay } from '../lib/domain/display.js';
import { setDateFormat, formatShortDate } from '../lib/domain/dates.js';
import { REPORTS } from '../lib/reports/registry.js';
import { GROUPS, REPORTS_MENU, GEAR, CREATE } from '../lib/views/nav.js';
import { startApp } from './app-harness.js';
import { tieout } from './tieout.js';
import { mvUser, signInAs, mvCompleteSetup } from './morning-fixtures.js';
import { trustedActor } from '../lib/data/morning/access.js';
import { grantSecondViewer } from '../lib/data/morning/identity.js';
import { saveSmsSettings } from '../lib/sms/twilio.js';
import { settingsKey } from '../lib/secrets.js';
import { approveTransport, transportSource } from '../lib/data/morning/transport.js';

// Stage B1: several companies in one account, each its own books. Company B is a second copy of the sample
// with every name starting "Zeta "; working in company A, no ordinary page, report, search or record of B may show up, and
// nothing typed into A's forms can reach B's records.
// Morning View intentionally spans companies for its two authorized viewers;
// The replacement below and morning-security.test.js check those boundaries.
const TODAY = '2026-10-12';
let app, pool, A, B, b;
const ZETA = /Zeta /;
before(async () => {
  app = await startApp();
  pool = app.db.pool;
  A = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const s = generateSample({ asOf: TODAY, seed: 7 });
  const z = x => `Zeta ${x}`;
  s.entity = { ...s.entity, name: 'Second Ranch Supply' };
  for (const c of s.customers) { c.display_name = z(c.display_name); c.company_name = c.company_name && z(c.company_name); c.email = c.email && `zeta.${c.email}`; }
  for (const v of s.vendors) { v.display_name = z(v.display_name); v.company_name = v.company_name && z(v.company_name); v.email = v.email && `zeta.${v.email}`; }
  for (const i of s.items) i.name = z(i.name);
  for (const a of s.accounts) a.name = z(a.name);
  for (const i of s.inventory?.items ?? []) i.name = z(i.name);
  for (const t of s.txns) t.memo = t.memo && z(t.memo);
  b = await writeSample(pool, s, { addCompany: true });
  B = { orgId: b.orgId, entityId: b.entityId };
  assert.equal(B.orgId, A.orgId);
  assert.notEqual(B.entityId, A.entityId);
});
after(async () => {
  for (const scope of [A, B]) {
    const c = await ledgerCheck(pool, scope);
    assert.ok(c.balanced && c.arMatches && c.apMatches && c.inventoryMatches, JSON.stringify(c));
  }
  await app.close();
});
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const ids = async (sql, p) => (await pool.query(sql, p)).rows.map(r => Number(Object.values(r)[0]));

test('working in company A, no page or report shows anything of company B', async () => {
  const paths = new Set(['/home', '/customers', '/vendors', '/deposits', '/time', '/reports', '/settings/accounts', '/settings/items', '/settings/terms',
    '/settings/classes', '/settings/tags', '/budgets', '/attachments', '/all-recurring', '/reconcile', '/checks', '/pay-bills', '/vendors/1099', '/apps', '/create',
    '/overview/sales', '/overview/expenses', '/overview/customers', '/overview/projects', '/overview/inventory', '/projects', '/search?q=a', '/search?q=zeta',
    `/customers/${app.ids.customers.redriver}?side=name`, `/txns/new?type=invoice`, `/vtxns/new?type=bill`, '/journal/new', '/deposits/new', '/transfers/new']);
  for (const g of [...GROUPS.flatMap(x => x.items), ...REPORTS_MENU, ...GEAR.flatMap(([, i]) => i), ...CREATE.flatMap(([, i]) => i)]) if (g.href) paths.add(g.href);
  for (const r of REPORTS) paths.add(`/reports/r/${r.key}?run=1&period=all`);
  let checked = 0;
  for (const p of paths) {
    const pathname = new URL(p, 'https://books.sample.example').pathname;
    if (/^\/(?:morning|settings\/morning)(?:\/|$)/.test(pathname)) continue;
    const res = await app.get(p);
    if (res.status !== 200) continue;
    const body = await res.text();
    assert.doesNotMatch(body, ZETA, `${p} shows company B`);
    checked++;
  }
  assert.ok(checked > 150, `checked ${checked} pages`);
  const s = await globalSearch(pool, { ...A, q: 'zeta', can: () => true });
  assert.ok(!s.sections.some(([t, rows]) => t !== 'Pages' && t !== 'Reports' && rows.length), 'search in A finds nothing of B');
});

test('company B’s records can’t be opened from company A', async () => {
  const bCust = Object.values(b.customers)[0], bVendor = Object.values(b.vendors ?? {})[0] ?? (await one('SELECT vendor_id FROM vendor WHERE entity_id = $1 LIMIT 1', [B.entityId])).vendor_id;
  const bInv = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'invoice' LIMIT 1`, [B.entityId])).txn_id;
  const bBill = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'bill' LIMIT 1`, [B.entityId])).txn_id;
  const bDep = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'deposit' LIMIT 1`, [B.entityId])).txn_id;
  const bAcct = (await one(`SELECT account_id FROM account WHERE entity_id = $1 AND system_key IS NULL LIMIT 1`, [B.entityId])).account_id;
  const bItem = (await one(`SELECT item_id FROM item WHERE entity_id = $1 LIMIT 1`, [B.entityId])).item_id;
  for (const p of [`/customers/${bCust}`, `/customers/${bCust}/edit`, `/customers/${bCust}?tab=details`, `/customers/${bCust}/export.xlsx`, `/customers/${bCust}/merge`,
    `/customers/${bCust}?tab=statements`, `/vendors/${bVendor}`, `/vendors/${bVendor}/edit`, `/txns/${bInv}`, `/txns/${bInv}.pdf`, `/txns/${bInv}/edit`,
    `/txns/${bInv}/packing-slip.pdf`, `/vtxns/${bBill}`, `/vtxns/${bBill}/edit`, `/deposits/${bDep}`, `/settings/accounts/${bAcct}`, `/settings/items/${bItem}`,
    `/txns/new?type=invoice&customer=${bCust}`, `/txns/new?type=payment&customer=${bCust}`, `/txns/new?copy=${bInv}`, `/vtxns/new?type=bill&vendor=${bVendor}`,
    `/pay-bills?vendor=${bVendor}`, `/customers/${bCust}/recurring/new`, `/reconcile/start?account=${bAcct}`, `/reports/r/customer_balance_detail?run=1&customer=${bCust}`]) {
    const res = await app.get(p);
    const body = res.status === 200 ? await res.text() : '';
    assert.ok(res.status !== 200 || !ZETA.test(body), `${p} → ${res.status} shows company B`);
    assert.notEqual(res.status, 500, `${p} is a server error`);
  }
});

test('nothing posted in company A can reach company B’s records', async () => {
  const before = await one(`SELECT count(*)::int AS n, coalesce(sum(open_cents), 0)::bigint AS open FROM txn WHERE entity_id = $1`, [B.entityId]);
  const custBefore = await one(`SELECT string_agg(customer_id || ':' || display_name || ':' || active, ',' ORDER BY customer_id) AS s FROM customer WHERE entity_id = $1`, [B.entityId]);
  const bCust = Object.values(b.customers)[0];
  const bInv = (await one(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'invoice' AND open_cents > 0 LIMIT 1`, [B.entityId]))?.txn_id;
  const bItem = (await one(`SELECT item_id FROM item WHERE entity_id = $1 LIMIT 1`, [B.entityId])).item_id;
  const bAcct = (await one(`SELECT account_id FROM account WHERE entity_id = $1 AND type = 'expense' LIMIT 1`, [B.entityId])).account_id;
  const bBank = (await one(`SELECT account_id FROM account WHERE entity_id = $1 AND type = 'bank' LIMIT 1`, [B.entityId])).account_id;
  const bTerms = (await one(`SELECT terms_id FROM terms WHERE entity_id = $1 LIMIT 1`, [B.entityId])).terms_id;
  const bVendor = (await one('SELECT vendor_id FROM vendor WHERE entity_id = $1 LIMIT 1', [B.entityId])).vendor_id;
  const aCust = app.ids.customers.hilltop, aVendor = app.ids.vendors.mill;
  const line = (p, item, rate = '5.00') => { p.append('line_item', String(item ?? '')); p.append('line_desc', 'x'); p.append('line_qty', '1'); p.append('line_rate', rate);
    p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', ''); p.append('line_class', ''); return p; };
  const attempts = [
    ['invoice for B’s customer', '/txns', line(new URLSearchParams({ type: 'invoice', customer_id: String(bCust), txn_date: TODAY }))],
    ['invoice with B’s item', '/txns', line(new URLSearchParams({ type: 'invoice', customer_id: String(aCust), txn_date: TODAY }), bItem)],
    ['invoice with B’s terms', '/txns', line(new URLSearchParams({ type: 'invoice', customer_id: String(aCust), txn_date: TODAY, terms_id: String(bTerms) }))],
    ['payment applied to B’s invoice', '/txns', new URLSearchParams({ type: 'payment', customer_id: String(aCust), txn_date: TODAY, amount: '1.00', ...(bInv ? { [`apply_${bInv}`]: '1.00' } : {}) })],
    ['customer with B’s terms', '/customers', new URLSearchParams({ displayName: 'Cross Terms', termsId: String(bTerms), shippingSameAsBilling: '1' })],
    ['B’s customer edited', `/customers/${bCust}`, new URLSearchParams({ displayName: 'Hijack', shippingSameAsBilling: '1' })],
    ['B’s customer made inactive', `/customers/${bCust}/active`, new URLSearchParams({ active: '0' })],
    ['merge A customer into B', `/customers/${aCust}/merge`, new URLSearchParams({ into: String(bCust) })],
    ['bill for B’s vendor', '/vtxns', (() => { const p = new URLSearchParams({ type: 'bill', vendor_id: String(bVendor), txn_date: TODAY });
      p.append('cat_account', String(bAcct)); p.append('cat_desc', ''); p.append('cat_amount', '5.00'); p.append('cat_job', ''); p.append('cat_po', ''); return p; })()],
    ['bill to B’s expense account', '/vtxns', (() => { const p = new URLSearchParams({ type: 'bill', vendor_id: String(aVendor), txn_date: TODAY });
      p.append('cat_account', String(bAcct)); p.append('cat_desc', ''); p.append('cat_amount', '5.00'); p.append('cat_job', ''); p.append('cat_po', ''); return p; })()],
    ['expense paid from B’s bank', '/vtxns', (() => { const p = new URLSearchParams({ type: 'expense', vendor_id: String(aVendor), txn_date: TODAY, account_id: String(bBank) });
      p.append('cat_account', String(app.ids.accounts.office)); p.append('cat_desc', ''); p.append('cat_amount', '5.00'); p.append('cat_job', ''); p.append('cat_po', ''); return p; })()],
    ['journal entry to B’s accounts', '/journal', (() => { const p = new URLSearchParams({ txn_date: TODAY });
      for (const [acct, d, c] of [[bAcct, '5', ''], [bBank, '', '5']]) { p.append('je_account', String(acct)); p.append('je_debit', d); p.append('je_credit', c); p.append('je_desc', ''); p.append('je_party', ''); p.append('je_class', ''); }
      return p; })()],
    ['transfer from B’s bank', '/transfers', new URLSearchParams({ txn_date: TODAY, from_account: String(bBank), to_account: String(app.ids.accounts.checking), amount: '5.00' })],
    ['B’s account renamed', `/settings/accounts/${bAcct}`, new URLSearchParams({ name: 'Hijacked', type: 'expense' })],
    ['B’s item renamed', `/settings/items/${bItem}`, new URLSearchParams({ name: 'Hijacked item', kind: 'service', rate: '1', active: '1' })],
  ];
  for (const [what, path, body] of attempts) {
    const res = await app.post(path, body);
    assert.notEqual(res.status, 500, `${what}: server error`);
  }
  const afterB = await one(`SELECT count(*)::int AS n, coalesce(sum(open_cents), 0)::bigint AS open FROM txn WHERE entity_id = $1`, [B.entityId]);
  assert.deepEqual(afterB, before, 'company B’s transactions are untouched');
  assert.deepEqual(await one(`SELECT string_agg(customer_id || ':' || display_name || ':' || active, ',' ORDER BY customer_id) AS s FROM customer WHERE entity_id = $1`, [B.entityId]),
    custBefore, 'company B’s customers are untouched (not renamed, not made inactive)');
  assert.equal((await one(`SELECT count(*)::int AS n FROM account WHERE entity_id = $1 AND name = 'Hijacked'`, [B.entityId])).n, 0);
  assert.equal((await one(`SELECT count(*)::int AS n FROM item WHERE entity_id = $1 AND name = 'Hijacked item'`, [B.entityId])).n, 0);
  // Nothing in A refers to anything of B.
  const cross = await one(`SELECT
      (SELECT count(*)::int FROM txn t JOIN customer c ON c.customer_id = t.customer_id WHERE t.entity_id <> c.entity_id) AS cust,
      (SELECT count(*)::int FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id WHERE t.entity_id <> v.entity_id) AS vend,
      (SELECT count(*)::int FROM posting p JOIN account a ON a.account_id = p.account_id WHERE p.entity_id <> a.entity_id) AS acct,
      (SELECT count(*)::int FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id JOIN item i ON i.item_id = l.item_id WHERE t.entity_id <> i.entity_id) AS item,
      (SELECT count(*)::int FROM customer c JOIN terms tm ON tm.terms_id = c.terms_id WHERE c.entity_id <> tm.entity_id) AS terms,
      (SELECT count(*)::int FROM application a JOIN txn c ON c.txn_id = a.credit_txn_id JOIN txn h ON h.txn_id = a.charge_txn_id WHERE c.entity_id <> h.entity_id) AS apps`);
  assert.deepEqual(cross, { cust: 0, vend: 0, acct: 0, item: 0, terms: 0, apps: 0 });
});

test('switching to company B shows B’s books and none of A’s; each ties out on its own', async () => {
  const res = await app.post('/company/switch', { entity_id: String(B.entityId) });
  assert.equal(res.status, 303);
  const home = await (await app.get('/customers')).text();
  assert.match(home, /Zeta /);
  for (const id of Object.values(app.ids.customers)) assert.ok(!home.includes(`href="/customers/${id}"`), `company A's customer ${id} listed in B`);
  assert.match(await (await app.get('/home')).text(), /Second Ranch Supply/);
  const t = tieout({ ...app, ids: { ...app.ids, orgId: B.orgId, entityId: B.entityId } });
  t.checkTied(await t.snapshot(), 'company B');
  assert.equal((await app.post('/company/switch', { entity_id: '999999' })).status, 404, 'not a company of this account');
  await app.post('/company/switch', { entity_id: String(A.entityId) });
  assert.doesNotMatch(await (await app.get('/customers')).text(), ZETA);
  tieout(app).checkTied(await tieout(app).snapshot(), 'company A');
});

test('a new company starts empty with a standard chart of accounts', async () => {
  const res = await app.post('/settings/companies', { name: 'Fresh Start LLC', timeZone: 'America/Denver' });
  assert.equal(res.status, 303);
  const e = await one(`SELECT entity_id FROM entity WHERE name = 'Fresh Start LLC'`);
  const counts = await one(`SELECT (SELECT count(*)::int FROM customer WHERE entity_id = $1) AS customers, (SELECT count(*)::int FROM txn WHERE entity_id = $1) AS txns,
    (SELECT count(*)::int FROM account WHERE entity_id = $1) AS accounts, (SELECT count(*)::int FROM terms WHERE entity_id = $1) AS terms`, [e.entity_id]);
  assert.deepEqual([counts.customers, counts.txns], [0, 0]);
  assert.ok(counts.accounts > 30 && counts.terms === 4);
  const page = await (await app.get('/customers')).text();
  assert.doesNotMatch(page, /Red River Farm|Zeta /, 'the new company is open and empty');
  assert.equal((await app.post('/settings/companies', { name: 'fresh start llc' })).status, 422, 'names are unique');
  await app.post('/company/switch', { entity_id: String(A.entityId) });
});

test('each company’s display settings stay its own, even at the same moment', async () => {
  const out = await Promise.all(['dmy', 'mdy', 'ymd'].map(f => withDisplay(async () => {
    setDateFormat(f);
    await new Promise(r => setTimeout(r, 20));
    return formatShortDate('2026-01-02');
  })));
  assert.deepEqual(out, ['2/1/26', '1/2/26', '2026-01-02']);
});

test('Morning is the only cross-company exception and excluded identities have neither routes nor links', async () => {
  app.env.SETTINGS_KEY = 'ab'.repeat(32);
  app.env.APP_BASE_URL = 'https://books.sample.example';
  const key = settingsKey(app.env), actorCtx = trustedActor({ owner: true }, A.orgId, app.ownerSession);
  assert.equal((await app.get('/settings/morning')).status, 200);
  await saveSmsSettings(pool, { orgId: A.orgId, enabled: true, accountSid: `AC${'ab'.repeat(16)}`, authToken: 'cd'.repeat(16), phone: '+16025550190', key, actor: 'the owner' });
  let source = await transportSource(pool, { orgId: A.orgId, channel: 'sms', env: app.env });
  await approveTransport(pool, { actorCtx, channel: 'sms', revision: source.row?.source_revision ?? 1, fingerprint: source.fingerprint, env: app.env });
  source = await transportSource(pool, { orgId: A.orgId, channel: 'sms', env: app.env });
  const decode = s => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
  const ownerBody = await (await app.get('/morning')).text();
  assert.match(ownerBody, ZETA);
  const form = /<form\b[^>]*action="\/morning\/dismiss"[^>]*>([^]*?)<\/form>/.exec(ownerBody);
  assert.ok(form, 'a current owner dismissal form');
  const fields = Object.fromEntries([...form[1].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(m => [m[1], decode(m[2])]));
  delete fields.csrf;
  const bank = (await one("SELECT account_id FROM account WHERE entity_id=$1 AND type='bank' LIMIT 1", [A.entityId])).account_id;
  const state = async () => {
    const out = {};
    const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'morning_%' ORDER BY tablename")).rows;
    for (const { tablename } of tables) out[tablename] = (await one(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${tablename} t`)).rows;
    return out;
  };
  for (const [i, role] of ['admin', 'admin', 'reports', 'standard'].entries()) {
    const email = `excluded${i}@sample.example`, u = await mvUser(pool, { orgId: A.orgId, email, role, allCompanies: i !== 1 });
    if (i === 1) await pool.query('INSERT INTO app_user_company(org_id,user_id,entity_id) VALUES($1,$2,$3)', [A.orgId, u.userId, A.entityId]);
    const client = await signInAs(app, { ...u, email });
    const routes = [
      ['GET', '/morning'], ['GET', `/morning/accounts/${bank}`], ['GET', '/morning/entries'], ['GET', '/morning/attention'], ['GET', '/morning/dismissed'], ['GET', '/settings/morning'],
      ['POST', '/morning/dismiss', { ...fields, note: 'sample' }], ['POST', '/morning/undismiss', { item_key: fields.item_key }],
      ['POST', '/settings/morning/preferences', { enabled: '1', send_time: '06:30', channel: 'sms', phone: '+16025550100', include_amounts: '', detail_threshold: '500' }],
      ['POST', '/settings/morning/floors', { account_id: bank, floor: '100.00' }], ['POST', '/settings/morning/viewer', { action: 'grant', user_id: u.userId }],
      ['POST', '/settings/morning/company-threshold', { entity_id: A.entityId, threshold: '25000.00' }], ['POST', '/settings/morning/delivery', { enabled: '1' }],
      ['POST', '/settings/morning/transport-approve', { channel: 'sms', revision: source.row.source_revision, fingerprint: source.fingerprint }],
    ];
    for (const [method, path, body] of routes) {
      const before = await state(), res = method === 'GET' ? await client.get(path) : await client.post(path, body);
      assert.equal(res.status, 403, `${role}/${i} ${method} ${path}`);assert.deepEqual(await state(), before);
    }
    for (const path of ['/home', '/settings', '/search?q=Morning', '/apps', '/bookmarks', '/navigation']) {
      const res = await client.get(path);assert.equal(res.status, 200, `${role} ${path}`);
      assert.doesNotMatch(await res.text(), /href="\/(?:morning|settings\/morning)(?:["/?])/);
    }
  }
  const u = await mvUser(pool, { orgId: A.orgId, email: 'allowed@sample.example', role: 'reports', allCompanies: false });
  await pool.query('INSERT INTO app_user_company(org_id,user_id,entity_id) VALUES($1,$2,$3)', [A.orgId, u.userId, A.entityId]);
  const issue = await grantSecondViewer(pool, { actorCtx, orgId: A.orgId, userId: u.userId, key, now: new Date(app.clock()) });
  const setup = await mvCompleteSetup(app, { token: issue.token });
  const client = { get: path => fetch(app.base + path, { redirect: 'manual', headers: { cookie: setup.cookie } }) };
  for (const who of [app, client]) {
    for (const path of ['/home', '/vendors', '/customers', '/reports', '/search?q=zeta']) {
      const res = await who.get(path);assert.equal(res.status, 200);assert.doesNotMatch(await res.text(), ZETA);
    }
    const session = who === app ? app.ownerSession : app.sessionFor(setup.cookie), selected = session.entityId;
    assert.equal(selected, A.entityId);
    for (const path of ['/morning', '/settings/morning']) {const res = await who.get(path);assert.equal(res.status, 200);assert.match(await res.text(), ZETA);}
    assert.equal(session.entityId, selected);
  }
});
