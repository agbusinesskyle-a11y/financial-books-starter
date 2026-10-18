// test/tax-worksheet-routes.test.js — the T3 pages (spec §8, §11): roles, the worksheet and its workpapers render for readers, writes for
// admins and the accountant where the company allows, 403 for standard users, forged companies and unknown years are 404, a 2026 period
// says it computes nothing, the drill-down reaches the account's transactions, a working revision and a typed item through the forms, a
// stale classification form is refused with the reason; and (Codex t3-plan-r1) a typed statement keeps every row through the form (B17),
// an accrual bill and a deposit outside the first week are selected and reviewed through the page with the versions shown (B2, B3), an
// adjustment naming another company's activity is refused (B9), and the worksheet never shows a missing value as 0.00 (B14).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { signInAs } from './tax-signin.js';
import { canAccess } from '../lib/domain/roles.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { createCompany } from '../lib/data/companies.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { saveBindings } from '../lib/tax/bindings.js';

let app, pool, S, here, ret, svc;
const profile = { returnType: 'form_1065', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12 };
const errorOf = async res => (/role="alert">([^<]*)</.exec(await res.clone().text()) ?? [])[1] ?? '';
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: 'ab'.repeat(32) } });
  pool = app.db.pool;
  S = { orgId: app.ids.orgId, entityId: await createCompany(pool, { orgId: app.ids.orgId, name: 'Larch Partners', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...S, fields: profile, reason: 'test setup', actor: 'test' });
  ret = Number(await openPeriod(pool, { ...S, year: 2025, actor: 'test' }));
  await openPeriod(pool, { ...S, year: 2026, actor: 'test' });
  const { rows } = await pool.query(`SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2 AND name IN ('Checking', 'Services', 'Retained Earnings')`, [S.orgId, S.entityId]);
  const id = n => Number(rows.find(r => r.name === n).account_id);
  svc = id('Services');
  await saveJournalEntry(pool, { ...S, actor: 'test', txnDate: '2025-03-01', docNumber: '', memo: 'sale', lines: [{ accountId: String(id('Checking')), debit: '500.00', credit: '', description: '' }, { accountId: String(svc), debit: '', credit: '500.00', description: '' }] });
  await saveJournalEntry(pool, { ...S, actor: 'test', txnDate: '2025-12-31', docNumber: 'CJE-1', memo: 'closing', lines: [{ accountId: String(svc), debit: '500.00', credit: '', description: '' }, { accountId: String(id('Retained Earnings')), debit: '', credit: '500.00', description: '' }] });
  for (const m of ['begin', 'end']) await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: id('Checking'), measurement: m, rows: [{ treatment: 'input', destination: 'f1065.L.1' }], actor: 'test' });
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: svc, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.1a' }], actor: 'test' });
  here = `/tax/${S.entityId}/2025`;
});
after(async () => { await app.close(); });

test('roles: readers open the pages; admins and the accountant write; standard users only read; customers and vendors never', () => {
  for (const [role, see, write] of [['admin', true, true], ['standard', true, false], ['reports', true, true], ['customers', false, false], ['vendors', false, false]]) {
    for (const p of ['', '/manual', '/adjustments', '/cash', '/cogs']) assert.equal(canAccess(role, 'GET', `${here}${p}`), see, `${role} GET ${p}`);
    for (const p of ['/revisions', '/manual/save', '/manual/rest', '/adjustments/add', '/adjustments/answer', '/cash/review', '/cash/classify', '/cogs/save', '/cogs/movement']) assert.equal(canAccess(role, 'POST', `${here}${p}`), write, `${role} POST ${p}`);
  }
  for (const a of ['final', 'reopen', 'filed']) assert.equal(canAccess('reports', 'POST', `${here}/${a}`), false, 'marking final stays admin-only (and does not exist yet)');
});

test('the worksheet and each workpaper render; the drill-down links the account’s transactions; a 2026 period computes nothing; unknown is 404', async () => {
  for (const p of ['', '/manual', '/adjustments', '/cash', '/cogs']) {
    const res = await app.get(`${here}${p}`);
    assert.equal(res.status, 200, p);
    assert.match(await res.text(), /Draft\./, p);
  }
  const page = await (await app.get(`${here}/cash`)).text();
  assert.match(page, /CJE-1/, 'the closing candidate is listed');
  const drill = await (await app.get(`${here}?line=${encodeURIComponent('f1065.L.1|end')}`)).text();
  assert.match(drill, new RegExp(`/reports/r/transaction_detail_by_account\\?run=1&amp;period=custom&amp;from=&amp;to=2025-12-31&amp;basis=accrual&amp;account=\\d+`));
  assert.match(await (await app.get(`/tax/${S.entityId}/2026`)).text(), /2026 forms are not in the app yet/);
  assert.equal((await app.get(`/tax/${S.entityId}/2027`)).status, 404);
  assert.equal((await app.get(`/tax/999999/2025`)).status, 404);
  assert.equal((await app.get(`${here}/manual/save`)).status, 405);
});

test('a stale classification form is refused with the reason; the current one classifies; a typed item and a working revision through the forms', async () => {
  const page = await (await app.get(`${here}/cash`)).text();
  const txn = /name="txn_id" value="(\d+)"/.exec(page)[1], version = /name="txn_version" value="([0-9a-f]{32})"/.exec(page)[1];
  const lines = [...page.matchAll(/name="line" value="(\d+)" checked/g)].map(m => m[1]);
  let res = await app.post(`${here}/cash/classify`, new URLSearchParams([['txn_id', txn], ['txn_version', 'f'.repeat(32)], ['class', 'closing'], ...lines.map(l => ['line', l])]));
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /changed since the page was shown/);
  res = await app.post(`${here}/cash/classify`, new URLSearchParams([['txn_id', txn], ['txn_version', version], ['class', 'closing'], ...lines.map(l => ['line', l])]));
  assert.equal(res.status, 303);
  res = await app.post(`${here}/manual/save`, { item_key: 'answer:k1_inflows', status: 'not_applicable' });
  assert.equal(res.status, 303);
  res = await app.post(`${here}/manual/save`, { item_key: 'f1065.p1.16a|activity', status: 'entered', amount: 'lots' });
  assert.equal(res.status, 422);
  res = await app.post(`${here}/revisions`, {});
  assert.equal(res.status, 303);
  assert.match(await (await app.get(here)).text(), /Revision 1, taken/);
});

test('standard users read but never write; the accountant writes only where the company allows', async () => {
  const std = await signInAs(app, { name: 'Stan Sample', email: 'stan.t3@sample.example', role: 'standard', csrfFrom: `/tax/${S.entityId}/profile` });
  assert.equal((await std.get(here)).status, 200);
  assert.equal((await std.post(`${here}/revisions`, {})).status, 403);
  const acct = await signInAs(app, { name: 'Ann Sample', email: 'ann.t3@sample.example', role: 'reports', csrfFrom: `/tax/${S.entityId}/profile` });
  assert.equal((await acct.post(`${here}/manual/save`, { item_key: 'f1065.p1.6|activity', status: 'not_applicable' })).status, 303);
  await saveProfile(pool, { ...S, fields: { ...profile, accountantMayEdit: false }, reason: 'test', actor: 'test' });
  assert.equal((await acct.post(`${here}/manual/save`, { item_key: 'f1065.p1.5|activity', status: 'not_applicable' })).status, 403);
  assert.equal((await acct.get(here)).status, 200);
});

// The fields of the form on a page that posts the given hidden item key (what a browser would send back), as [name, value] pairs.
const formFor = (page, action, marker) => {
  const forms = [...page.matchAll(/<form method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].filter(m => m[1] === action && m[2].includes(marker));
  assert.equal(forms.length, 1, `one form for ${marker}`);
  return [...forms[0][2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].filter(m => m[1] !== 'csrf' && m[1] !== 'form_once').map(m => [m[1], m[2].replaceAll('&amp;', '&')]);
};

test('a typed statement keeps every row (Codex t3-plan-r1 B17): two rows entered, one edited through the form as the page shows it, the untouched row and the total kept; a refused edit changes nothing', async () => {
  const { assignProvider } = await import('../lib/tax/providers.js');
  const { listManualItems } = await import('../lib/tax/manual.js');
  await assignProvider(pool, { ...S, returnId: ret, slotKey: 'f1065.p1.21|activity', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'reviewed statement' }, sourceVersion: 'manual:statement@1' });
  const key = 'f1065.p1.21|activity';
  let res = await app.post(`${here}/manual/save`, { item_key: key, status: 'entered', row_count: '4', label_0: 'Bank fees', amount_0: '12.00', label_1: 'Postage', amount_1: '8.50', label_2: '', amount_2: '', label_3: '', amount_3: '' });
  assert.equal(res.status, 303);
  const stored = async () => (await listManualItems(pool, { orgId: S.orgId, returnId: ret })).find(i => i.item_key === key).rows.map(x => [x.label, x.cents]);
  assert.deepEqual(await stored(), [['Bank fees', 1200n], ['Postage', 850n]]);
  // The page shows both rows (and two blank ones to add): edit only the second, send the form back as shown.
  let page = await (await app.get(`${here}/manual`)).text();
  let fields = formFor(page, `${here}/manual/save`, `value="${key}"`);
  assert.deepEqual(fields.filter(([n]) => /^(label|amount)_[01]$/.test(n)), [['label_0', 'Bank fees'], ['amount_0', '12.00'], ['label_1', 'Postage'], ['amount_1', '8.50']]);
  res = await app.post(`${here}/manual/save`, new URLSearchParams([...fields.map(([n, v]) => [n, n === 'amount_1' ? '9.75' : v]), ['status', 'entered']]));
  assert.equal(res.status, 303);
  assert.deepEqual(await stored(), [['Bank fees', 1200n], ['Postage', 975n]], 'the untouched row is kept');
  // A refused edit (a row with a name and no amount) changes nothing, and the page shows the stored rows again.
  page = await (await app.get(`${here}/manual`)).text();
  fields = formFor(page, `${here}/manual/save`, `value="${key}"`);
  res = await app.post(`${here}/manual/save`, new URLSearchParams([...fields.map(([n, v]) => [n, n === 'label_2' ? 'Courier' : v]), ['status', 'entered']]));
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /Row 3: give it a name and an amount/);
  assert.deepEqual(await stored(), [['Bank fees', 1200n], ['Postage', 975n]]);
  assert.match(await res.text(), /value="Postage"/);
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [S.orgId, ret]);
  await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [S.orgId, ret, key]);
});

test('an accrual return’s bill is selected and reviewed through the page (Codex t3-plan-r1 B2), and the page shows the decision as changed once the bill is edited; a transaction given by its number too', async () => {
  const { bill } = await import('./tax-t3-fixtures.js');
  const { accrualTiming } = await import('../lib/tax/cash.js');
  const { rows: [rent] } = await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = 'Rent & Lease'`, [S.orgId, S.entityId]);
  const related = await bill(pool, S, '2025-12-20', [[Number(rent.account_id), 6000]]);
  const other = await bill(pool, S, '2025-12-21', [[Number(rent.account_id), 1000]]);
  const page = await (await app.get(`${here}/cash`)).text();
  const pick = new RegExp(`<option value="(${related}:[0-9a-f]{32}:[0-9a-f]{32})"`).exec(page)?.[1];
  assert.ok(pick, 'the bill unpaid at the year end is offered');
  let res = await app.post(`${here}/cash/review`, { pick, kind: 'related_party_accrual', decision: 'exclude', reason: 'Owed to a related party, unpaid' });
  assert.equal(res.status, 303);
  res = await app.post(`${here}/cash/review`, { pick: '', txn_id: String(other), kind: 'economic_performance', decision: 'exclude', reason: 'Service in January' });
  assert.equal(res.status, 303);
  const RL = { return_id: ret, entity_id: S.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  let gate = await accrualTiming(pool, { orgId: S.orgId, ret: RL });
  assert.deepEqual([related, other].map(id => gate.candidates.find(c => c.txnId === id)?.state), ['decided', 'decided']);
  assert.equal(gate.exclusions.length, 2);
  await pool.query('UPDATE posting SET amount_cents = amount_cents * 2 WHERE txn_id = $1', [related]);
  await pool.query('UPDATE txn SET total_cents = 12000 WHERE txn_id = $1', [related]);
  gate = await accrualTiming(pool, { orgId: S.orgId, ret: RL });
  assert.equal(gate.candidates.find(c => c.txnId === related).state, 'stale');
  assert.match(await (await app.get(`${here}/cash`)).text(), /changed since decided \(Accrual to a related party: exclude\)/);
  // A decision posted from an old page (its event version) is refused with the reason.
  res = await app.post(`${here}/cash/review`, { pick, kind: 'related_party_accrual', decision: 'exclude' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /changed since the page was shown/);
  for (const id of [related, other]) { await pool.query('DELETE FROM cash_timing_review WHERE txn_id = $1', [id]); await pool.query('DELETE FROM posting WHERE txn_id = $1', [id]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [id]); }
});

test('a cash-method deposit outside the first week is selected for its receipt date through the page (Codex t3-plan-r1 B3)', async () => {
  const C = { orgId: app.ids.orgId, entityId: await createCompany(pool, { orgId: app.ids.orgId, name: 'Linden Cash Partners', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...C, fields: { ...profile, taxMethodDefault: 'cash' }, reason: 'test setup', actor: 'test' });
  await openPeriod(pool, { ...C, year: 2024, actor: 'test' });
  const r25 = Number(await openPeriod(pool, { ...C, year: 2025, actor: 'test' }));
  const { deposit } = await import('./tax-t3-fixtures.js');
  const { cashRecognition } = await import('../lib/tax/cash.js');
  const { rows } = await pool.query(`SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2 AND name IN ('Checking', 'Services')`, [C.orgId, C.entityId]);
  const id = n => Number(rows.find(r => r.name === n).account_id);
  const dep = await deposit(pool, C, '2025-01-10', id('Checking'), [[id('Services'), 500]]);
  const base = `/tax/${C.entityId}/2025`;
  const page = await (await app.get(`${base}/cash`)).text();
  const pick = new RegExp(`<option value="(${dep}:[0-9a-f]{32}:[0-9a-f]{32})"`).exec(page)?.[1];
  assert.ok(pick, 'a January 10 deposit is not suggested, but can be selected');
  const res = await app.post(`${base}/cash/review`, { pick, kind: 'receipt_date', decision: 'include', recognize_on: '2024-12-28', reason: 'Card batch of December 28' });
  assert.equal(res.status, 303);
  const R25 = { return_id: r25, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' };
  assert.equal((await cashRecognition(pool, { orgId: C.orgId, ret: R25 })).byAccount.get(id('Services')) ?? 0n, 0n, 'moved out of 2025');
});

test('the worksheet shows a value it was not given as "not computed", never 0.00, and lists the lines that wait for stage T4 per owner', async () => {
  const { taxWorksheetPage } = await import('../lib/views/tax-worksheet.js');
  const r = { ret: { return_id: 1, entity_id: 1, return_type: 'form_1065', form_edition: 2025, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash', book_basis: 'accrual' }, refused: null,
    fields: [{ key: 'f1065.p1.10|interest=i:t4|activity', fieldId: 'f1065.p1.10', dims: { interest: 'i:t4' }, measurement: 'activity', cents: null, status: 'unresolved', reasons: ['Guaranteed payments are computed with the partners’ records in stage T4.'] },
      { key: 'f1065.p1.1a|activity', fieldId: 'f1065.p1.1a', dims: {}, measurement: 'activity', cents: '0', status: 'complete', reasons: [] }],
    checks: [], bridge: { bookNetIncome: '0', endpoint: 'f1065.anal.1', endpointCents: null, m1Cents: null, residual: null, rows: [], unknown: [] }, slots: [], deltas: [], cogs: new Map() };
  const out = String(taxWorksheetPage({ entityName: 'x', csrf: 'c', flash: null, company: { entityId: 1, name: 'Sample' }, year: 2025, r, canEdit: false }));
  assert.match(out, /Guaranteed payments to partners \(the owners — stage T4\)/);
  const row = id => new RegExp(`>${id}</a?>?[\\s\\S]*?</tr>`).exec(out)?.[0] ?? new RegExp(`<td data-label="Line">${id}</td>[\\s\\S]*?</tr>`).exec(out)?.[0] ?? '';
  assert.match(row('1b'), /not computed/, 'a line with no value is not shown as zero');
  assert.doesNotMatch(row('1b'), /0\.00/);
  assert.match(row('1a'), /\$0\.00|0\.00/, 'a known zero is shown as zero');
});

test('an accepted proposal whose source no longer matches is shown on the adjustments page with its lines and can be withdrawn there (Codex t3-r1 B5): accepted through the page, the account renamed, the orphaned decision listed and the worksheet line not known; withdrawn through the page, the full deduction is known', async () => {
  const { answerTypedItems, compute } = await import('./tax-t3-fixtures.js');
  const M = { orgId: app.ids.orgId, entityId: await createCompany(pool, { orgId: app.ids.orgId, name: 'Larch Meals Partners', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...M, fields: profile, reason: 'test setup', actor: 'test' });
  const mRet = Number(await openPeriod(pool, { ...M, year: 2025, actor: 'test' }));
  const { rows } = await pool.query(`SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2 AND name IN ('Checking', 'Services', 'Meals', 'Retained Earnings')`, [M.orgId, M.entityId]);
  const id = n => Number(rows.find(r => r.name === n).account_id);
  await saveJournalEntry(pool, { ...M, actor: 'test', txnDate: '2025-03-01', docNumber: '', memo: 'sale', lines: [{ accountId: String(id('Checking')), debit: '500.00', credit: '', description: '' }, { accountId: String(id('Services')), debit: '', credit: '500.00', description: '' }] });
  await saveJournalEntry(pool, { ...M, actor: 'test', txnDate: '2025-04-01', docNumber: '', memo: 'lunch', lines: [{ accountId: String(id('Meals')), debit: '100.00', credit: '', description: '' }, { accountId: String(id('Checking')), debit: '', credit: '100.00', description: '' }] });
  for (const m of ['begin', 'end']) await saveBindings(pool, { ...M, returnId: mRet, sourceEntityId: M.entityId, accountId: id('Checking'), measurement: m, rows: [{ treatment: 'input', destination: 'f1065.L.1' }], actor: 'test' });
  await saveBindings(pool, { ...M, returnId: mRet, sourceEntityId: M.entityId, accountId: id('Retained Earnings'), measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.21' }], actor: 'test' });
  await saveBindings(pool, { ...M, returnId: mRet, sourceEntityId: M.entityId, accountId: id('Services'), measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.1a' }], actor: 'test' });
  await saveBindings(pool, { ...M, returnId: mRet, sourceEntityId: M.entityId, accountId: id('Meals'), measurement: 'activity', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21' }], actor: 'test' });
  await answerTypedItems(pool, M, mRet);
  const there = `/tax/${M.entityId}/2025`;
  let page = await (await app.get(`${there}/adjustments`)).text();
  const key = /name="key" value="(meals_50:[^"]+)"/.exec(page)[1], version = /name="version" value="([0-9a-f]{32})"/.exec(page)[1];
  let res = await app.post(`${there}/adjustments/answer`, { key, version, decision: 'accept' });
  assert.equal(res.status, 303);
  let r = await compute(pool, M, mRet);
  assert.equal(r.fields.find(x => x.key === 'f1065.p1.21|activity').cents, '5000');
  await pool.query(`UPDATE account SET name = 'Staff costs' WHERE account_id = $1`, [id('Meals')]);
  res = await app.get(`${there}/adjustments`);
  assert.equal(res.status, 200);
  page = await res.text();
  assert.match(page, /no longer match/i, 'the orphaned decision is listed');
  const withdraw = formFor(page, `${there}/adjustments/withdraw`, 'name="group_id"');
  const groupId = withdraw.find(([n]) => n === 'group_id')[1];
  assert.ok(/^\d+$/.test(groupId), 'the form names the group');
  assert.match(page, /\(Meals\) — 21 -\$50\.00, 18c \$50\.00/, 'with its lines');
  r = await compute(pool, M, mRet);
  assert.deepEqual([r.fields.find(x => x.key === 'f1065.p1.21|activity').cents, r.fields.find(x => x.key === 'f1065.p1.21|activity').status], [null, 'unresolved']);
  assert.match(await (await app.get(there)).text(), /no longer match/i, 'the worksheet names the orphaned decision among its checks');
  res = await app.post(`${there}/adjustments/withdraw`, { group_id: groupId, reason: 'The account is not meals any more' });
  assert.equal(res.status, 303);
  r = await compute(pool, M, mRet);
  assert.deepEqual([r.fields.find(x => x.key === 'f1065.p1.21|activity').cents, r.fields.find(x => x.key === 'f1065.k.18c|activity').cents], ['10000', '0']);
  assert.doesNotMatch(await (await app.get(`${there}/adjustments`)).text(), /no longer match/i);
});

test('the typed items page renders a comparison whose book amount is not known (Codex t3-r1 note 1): a line-attributed book depreciation beside a typed deduction, its transaction deleted — GET 200, the book side "not known" with the mapping reason, the typed amount still editable', async () => {
  const { attributeLine } = await import('../lib/tax/bindings.js');
  const { measureLines } = await import('../lib/tax/measure.js');
  const { saveManualItem } = await import('../lib/tax/manual.js');
  const { rows: [d] } = await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = 'Depreciation'`, [S.orgId, S.entityId]);
  const dep = Number(d.account_id);
  const txnId = Number(await saveJournalEntry(pool, { ...S, actor: 'test', txnDate: '2025-05-01', docNumber: '', memo: 'book depreciation', lines: [{ accountId: String(dep), debit: '10.00', credit: '', description: '' }, { accountId: String(await (async () => Number((await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = 'Checking'`, [S.orgId, S.entityId])).rows[0].account_id))()), debit: '', credit: '10.00', description: '' }] }));
  const [l] = (await measureLines(pool, { orgId: S.orgId, sourceEntityId: S.entityId, accountIds: [dep], periodStart: '2025-01-01', periodEnd: '2025-12-31', returnId: ret })).get(dep);
  await attributeLine(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: dep, txnId, lineNo: l.lineNo, expectTxnVersion: l.txnVersion, target: { treatment: 'manual_feed', destination: 'f1065.p1.16a' }, actor: 'test' });
  try {
    await saveManualItem(pool, { ...S, returnId: ret, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '250.00', enteredBy: 'test' });
    const text = html => html.replace(/<[^>]+>/g, '');
    assert.match(text(await (await app.get(`${here}/manual`)).text()), /Books beside it: Depreciation \$10\.00/, 'the comparison with its book amount');
    await pool.query('DELETE FROM posting WHERE txn_id = $1', [txnId]);
    await pool.query('DELETE FROM txn WHERE txn_id = $1', [txnId]);
    const res = await app.get(`${here}/manual`);
    assert.equal(res.status, 200, 'the page renders with the stale attribution');
    const page = await res.text();
    assert.match(text(page), /Books beside it: Depreciation not known \(\S/, 'the book side is not known, with the mapping reason');
    const fields = formFor(page, `${here}/manual/save`, 'value="f1065.p1.16a|activity"');
    assert.deepEqual(fields.filter(([n]) => n === 'amount'), [['amount', '250.00']], 'the typed amount is still editable');
  } finally {
    await pool.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [S.orgId, ret, dep]);
    await pool.query(`DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = 'f1065.p1.16a|activity'`, [S.orgId, ret]);
  }
});

test('through the page, an adjustment naming another company’s activity, a nonexistent one or a stage-T4 owner is refused with the reason (Codex t3-plan-r1 B9)', async () => {
  const { saveActivity } = await import('../lib/tax/activities.js');
  const O = { orgId: app.ids.orgId, entityId: await createCompany(pool, { orgId: app.ids.orgId, name: 'Larch Sibling Partners', timeZone: 'America/Chicago' }) };
  const theirs = Number(await saveActivity(pool, { ...O, fields: { kind: 'trade', name: 'Sibling trade', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } }));
  for (const [slot, why] of [[`f1125a.main.3|activity=act:${theirs}|activity`, /is not an activity of this company/], ['f1125a.main.3|activity=act:999999999|activity', /is not an activity of this company/],
    ['f1065.p1.10|interest=i:t4|activity', /stage T4/]]) {
    const res = await app.post(`${here}/adjustments/add`, { purpose: 'other', memo: 'Sample', evidence: 'Sample workpaper', slot_0: slot, amount_0: '5.00', class_0: 'other' });
    assert.equal(res.status, 422, slot);
    assert.match(await errorOf(res), why);
  }
});

test('a reviewed COGS workpaper keeps every other cost through its form (Codex t3-plan-r2 R2-9): the note edited alone, one row edited, one added, one removed, a refused edit — none lost', async () => {
  const { saveActivity } = await import('../lib/tax/activities.js');
  const { saveWorkpaper, listWorkpapers } = await import('../lib/tax/cogs.js');
  const act = Number(await saveActivity(pool, { ...S, fields: { kind: 'trade', name: 'Larch shop', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } }));
  await saveWorkpaper(pool, { ...S, returnId: ret, activityId: act, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedBy: 'test', sourceNote: 'Count sheets',
    reviewedLines: { '1': '0', '2': '500.00', '3': '0', '4': '0', '7': '0', '5': [{ label: 'Freight', amount: '20.00' }, { label: 'Duties', amount: '5.00' }] } });
  const other = async () => (await listWorkpapers(pool, { orgId: S.orgId, returnId: ret })).find(w => w.activity_id === act).reviewed_lines['5'].map(x => [x.label, x.cents]);
  const form = async () => formFor(await (await app.get(`${here}/cogs`)).text(), `${here}/cogs/save`, `name="activity_id" value="${act}"`);
  const post = async change => app.post(`${here}/cogs/save`, new URLSearchParams((await form()).filter(([n]) => !['lifo', 'subnormal', 'valuation_changed'].includes(n)).map(([n, v]) => [n, change[n] ?? v]).concat([['path', 'reviewed'], ['treatment', 'inventory_as_booked'], ['method', 'cost']])));
  assert.equal((await post({ note: 'Count sheets, signed' })).status, 303);
  assert.deepEqual(await other(), [['Freight', '2000'], ['Duties', '500']], 'the note alone: both rows kept');
  assert.equal((await listWorkpapers(pool, { orgId: S.orgId, returnId: ret })).find(w => w.activity_id === act).lifo, false, 'an unchecked flag stays unchecked');
  assert.equal((await post({ other_amount_1: '7.50' })).status, 303);
  assert.equal((await post({ other_label_2: 'Packing', other_amount_2: '3.00' })).status, 303);
  assert.deepEqual(await other(), [['Freight', '2000'], ['Duties', '750'], ['Packing', '300']]);
  assert.equal((await post({ other_label_0: '', other_amount_0: '' })).status, 303, 'a row removed only when blanked on purpose');
  assert.deepEqual(await other(), [['Duties', '750'], ['Packing', '300']]);
  const res = await post({ other_amount_1: '' });
  assert.equal(res.status, 422);
  assert.deepEqual(await other(), [['Duties', '750'], ['Packing', '300']], 'a refused edit changes nothing');
});

test('one row limit for a typed statement, in the page, the form and the save (Codex t3-plan-r2 R2-9): at the limit kept whole, beyond it refused, never cut off; a refused save shows what was typed', async () => {
  const { assignProvider } = await import('../lib/tax/providers.js');
  const { saveManualItem, listManualItems, MAX_STATEMENT_ROWS } = await import('../lib/tax/manual.js');
  await assignProvider(pool, { ...S, returnId: ret, slotKey: 'f1065.p1.21|activity', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'reviewed statement' }, sourceVersion: 'manual:statement@2' });
  const key = 'f1065.p1.21|activity';
  const many = n => Array.from({ length: n }, (_, i) => ({ label: `Row ${i + 1}`, amount: '1.00' }));
  await assert.rejects(saveManualItem(pool, { ...S, returnId: ret, itemKey: key, status: 'entered', rows: many(MAX_STATEMENT_ROWS + 1), enteredBy: 'test' }), /at most 100 rows/);
  await saveManualItem(pool, { ...S, returnId: ret, itemKey: key, status: 'entered', rows: many(MAX_STATEMENT_ROWS), enteredBy: 'test' });
  const page = await (await app.get(`${here}/manual`)).text();
  const fields = formFor(page, `${here}/manual/save`, `value="${key}"`);
  assert.equal(fields.find(([n]) => n === 'row_count')[1], String(MAX_STATEMENT_ROWS), 'all stored rows shown, no blank row beyond the limit');
  let res = await app.post(`${here}/manual/save`, new URLSearchParams([...fields, ['status', 'entered']]));
  assert.equal(res.status, 303);
  assert.equal((await listManualItems(pool, { orgId: S.orgId, returnId: ret })).find(i => i.item_key === key).rows.length, MAX_STATEMENT_ROWS, 'resubmitted whole');
  res = await app.post(`${here}/manual/save`, new URLSearchParams([...fields.filter(([n]) => n !== 'row_count'), ['row_count', String(MAX_STATEMENT_ROWS + 3)], ['status', 'entered']]));
  assert.equal(res.status, 422, 'a form claiming more rows than the page can show is refused');
  // A refused edit shows the typed rows again, the stored ones unchanged.
  res = await app.post(`${here}/manual/save`, new URLSearchParams([...fields.map(([n, v]) => [n, n === 'label_0' ? 'Courier' : n === 'amount_0' ? 'lots' : v]), ['status', 'entered']]));
  assert.equal(res.status, 422);
  assert.match(await res.text(), /value="Courier"/, 'what was typed is kept on the page');
  assert.equal((await listManualItems(pool, { orgId: S.orgId, returnId: ret })).find(i => i.item_key === key).rows[0].label, 'Row 1');
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [S.orgId, ret]);
  await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [S.orgId, ret, key]);
});

test('a typed item’s support survives edits through the page (Codex t3-plan-r3 R3-6): an amount and a statement row edited keep it; changing or emptying the support is the explicit choice; a refused edit keeps it; a revision holds it', async () => {
  const { assignProvider } = await import('../lib/tax/providers.js');
  const { saveManualItem, listManualItems } = await import('../lib/tax/manual.js');
  const { getRevision } = await import('../lib/tax/engine/revision.js');
  await assignProvider(pool, { ...S, returnId: ret, slotKey: 'f1065.p1.21|activity', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'reviewed statement' }, sourceVersion: 'manual:statement@3' });
  const scalar = 'f1065.p1.6|activity', multi = 'f1065.p1.21|activity';
  await saveManualItem(pool, { ...S, returnId: ret, itemKey: scalar, status: 'entered', amount: '40.00', workpaper: 'Form 4797 worksheet, page 2', enteredBy: 'test' });
  await saveManualItem(pool, { ...S, returnId: ret, itemKey: multi, status: 'entered', rows: [{ label: 'Bank fees', amount: '12.00' }, { label: 'Postage', amount: '8.50' }], workpaper: 'Statement binder, tab 4', enteredBy: 'test' });
  const support = async key => (await listManualItems(pool, { orgId: S.orgId, returnId: ret })).find(i => i.item_key === key)?.workpaper ?? null;
  const send = async (key, change) => {
    const fields = formFor(await (await app.get(`${here}/manual`)).text(), `${here}/manual/save`, `value="${key}"`);
    return app.post(`${here}/manual/save`, new URLSearchParams([...fields.map(([n, v]) => [n, Object.hasOwn(change, n) ? change[n] : v]), ['status', 'entered']]));
  };
  assert.equal((await send(scalar, { amount: '45.00' })).status, 303);
  assert.equal((await send(multi, { amount_1: '9.75' })).status, 303);
  assert.deepEqual([await support(scalar), await support(multi)], ['Form 4797 worksheet, page 2', 'Statement binder, tab 4'], 'kept through amount and row edits');
  const refused = await send(multi, { amount_0: 'lots' });
  assert.equal(refused.status, 422);
  assert.equal(await support(multi), 'Statement binder, tab 4', 'a refused edit keeps it');
  // Without the field at all (another client): kept. Changed, then emptied on purpose: replaced, then cleared.
  assert.equal((await app.post(`${here}/manual/save`, { item_key: scalar, status: 'entered', amount: '45.00' })).status, 303);
  assert.equal(await support(scalar), 'Form 4797 worksheet, page 2');
  await takeRevision();
  assert.equal((await send(scalar, { workpaper: 'Form 4797 worksheet, corrected' })).status, 303);
  assert.equal(await support(scalar), 'Form 4797 worksheet, corrected');
  assert.equal((await send(scalar, { workpaper: '' })).status, 303);
  assert.equal(await support(scalar), null, 'emptied on purpose: cleared');
  const { rows: [n] } = await pool.query('SELECT max(revision_no) AS n FROM tax_return_revision WHERE return_id = $1', [ret]);
  const saved = await getRevision(pool, { ...S, returnId: ret, revisionNo: Number(n.n) });
  assert.equal(saved.inputs.manual.find(m => m.key === scalar).workpaper, 'Form 4797 worksheet, page 2', 'the revision holds the support it was taken with');
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [S.orgId, ret]);
  await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = ANY($3)', [S.orgId, ret, [scalar, multi]]);
  async function takeRevision() { assert.equal((await app.post(`${here}/revisions`, {})).status, 303); }
});

// Every field a browser would send back from one form: inputs (checkboxes only when checked) and each select's selected option.
const wholeFormFor = (page, action, marker) => {
  const forms = [...page.matchAll(/<form method="post" action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].filter(m => m[1] === action && m[2].includes(marker));
  assert.equal(forms.length, 1, `one form for ${marker}`);
  const body = forms[0][2], out = [];
  for (const m of body.matchAll(/<input([^>]*)>/g)) {
    const at = (n) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1])?.[1];
    const name = at('name');
    if (!name || name === 'csrf' || name === 'form_once') continue;
    if (/type="checkbox"/.test(m[1]) && !/\bchecked\b/.test(m[1])) continue;
    out.push([name, (at('value') ?? '').replaceAll('&amp;', '&').replaceAll('&#39;', '’')]);
  }
  for (const s of body.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const chosen = /<option value="([^"]*)" selected/.exec(s[2]) ?? /<option value="([^"]*)"/.exec(s[2]);
    out.push([s[1], chosen?.[1] ?? '']);
  }
  return out;
};
const sendForm = (action, fields, change = {}) => app.post(action, new URLSearchParams(fields.filter(([n]) => !Object.hasOwn(change, n) || change[n] !== null).map(([n, v]) => [n, Object.hasOwn(change, n) ? change[n] : v])));

test('decision forms carry the saved decision, so an unchanged save changes nothing (Codex t3-plan-r6 R6-5): a mixed closing’s exact subset, an excluded economic-performance bill, an included advance; the note kept when the form omits it, cleared only on purpose; deliberate edits apply; revisions hold the old and new notes', async () => {
  const { computeReturn } = await import('../lib/tax/engine/compute.js');
  const { getRevision } = await import('../lib/tax/engine/revision.js');
  const { bill, payment } = await import('./tax-t3-fixtures.js');
  const { cashRecognition } = await import('../lib/tax/cash.js');
  const value = (r, k) => r.fields.find(f => f.key === k)?.cents ?? null;
  const { rows } = await pool.query(`SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2 AND name IN ('Checking', 'Services', 'Utilities', 'Rent & Lease', 'Retained Earnings', 'Opening Balance Equity')`, [S.orgId, S.entityId]);
  const id = n => Number(rows.find(r => r.name === n).account_id);
  // 1. A mixed journal: lines 1-2 close Services into retained earnings; lines 3-4 are a genuine correction between Utilities and equity.
  await saveJournalEntry(pool, { ...S, actor: 'test', txnDate: '2025-07-01', docNumber: '', memo: 'utilities', lines: [{ accountId: String(id('Utilities')), debit: '100.00', credit: '', description: '' }, { accountId: String(id('Checking')), debit: '', credit: '100.00', description: '' }] });
  const mixed = Number(await saveJournalEntry(pool, { ...S, actor: 'test', txnDate: '2025-12-31', docNumber: 'CJE-9', memo: 'mixed', lines: [
    { accountId: String(svc), debit: '200.00', credit: '', description: '' }, { accountId: String(id('Retained Earnings')), debit: '', credit: '200.00', description: '' },
    { accountId: String(id('Utilities')), debit: '', credit: '100.00', description: '' }, { accountId: String(id('Opening Balance Equity')), debit: '100.00', credit: '', description: '' }] }));
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: id('Utilities'), measurement: 'activity', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21' }], actor: 'test' });
  let page = await (await app.get(`${here}/cash`)).text();
  let fields = wholeFormFor(page, `${here}/cash/classify`, `value="${mixed}"`);
  assert.deepEqual(fields.filter(([n]) => n === 'line').map(([, v]) => v), ['1', '2', '3', '4'], 'a NEW decision proposes every income, expense and equity line');
  assert.equal((await sendForm(`${here}/cash/classify`, fields.filter(([n, v]) => n !== 'line' || ['1', '2'].includes(v)), { class: 'closing', reason: 'Lines 3 and 4 correct a miscoding' })).status, 303);
  const saved = async () => { const { rows: [d] } = await pool.query('SELECT lines, reason FROM book_entry_classification WHERE txn_id = $1', [mixed]); return d ? [d.lines, d.reason] : null; };
  assert.deepEqual(await saved(), [[1, 2], 'Lines 3 and 4 correct a miscoding']);
  const before = await computeReturn(pool, { ...S, returnId: ret });
  page = await (await app.get(`${here}/cash`)).text();
  fields = wholeFormFor(page, `${here}/cash/classify`, `value="${mixed}"`);
  assert.deepEqual(fields.filter(([n]) => n === 'line').map(([, v]) => v), ['1', '2'], 'the form shows the SAVED subset, not the proposal');
  const byName = f => Object.fromEntries(f);
  assert.deepEqual([byName(fields).class, byName(fields).reason], ['closing', 'Lines 3 and 4 correct a miscoding']);
  assert.equal((await sendForm(`${here}/cash/classify`, fields)).status, 303);
  assert.deepEqual(await saved(), [[1, 2], 'Lines 3 and 4 correct a miscoding'], 'an unchanged save changes nothing');
  const after = await computeReturn(pool, { ...S, returnId: ret });
  for (const k of ['f1065.p1.1a|activity', 'f1065.p1.21|activity', 'f1065.p1.23|activity']) assert.equal(value(after, k), value(before, k), k);
  assert.equal(value(after, 'f1065.p1.21|activity'), '0', 'the correction pair stays in the measurement (its credit nets the expense)');
  assert.equal((await sendForm(`${here}/cash/classify`, fields.filter(([n]) => n !== 'reason'))).status, 303, 'a client without the note field');
  assert.deepEqual(await saved(), [[1, 2], 'Lines 3 and 4 correct a miscoding'], 'the note is kept when the form omits it');
  assert.equal((await sendForm(`${here}/cash/classify`, fields, { reason: '' })).status, 303);
  assert.deepEqual(await saved(), [[1, 2], null], 'emptied on purpose: cleared');
  // A deliberate edit of the subset applies (and is refused when it does not balance on its own).
  assert.equal((await sendForm(`${here}/cash/classify`, [...fields, ['line', '3'], ['line', '4']])).status, 303);
  assert.deepEqual((await saved())[0], [1, 2, 3, 4]);
  assert.equal(value(await computeReturn(pool, { ...S, returnId: ret }), 'f1065.p1.21|activity'), '10000', 'all four lines removed, the correction’s credit with them: the deliberate choice');
  assert.equal((await sendForm(`${here}/cash/classify`, [...fields, ['line', '3']])).status, 422);
  await pool.query('DELETE FROM book_entry_classification WHERE txn_id = $1', [mixed]);
  // 2. A bill excluded as economic performance not met: the form shows that kind and decision; an unchanged save keeps them.
  const perf = await bill(pool, S, '2025-12-22', [[id('Rent & Lease'), 700]]);
  page = await (await app.get(`${here}/cash`)).text();
  const pick = new RegExp(`<option value="(${perf}:[0-9a-f]{32}:[0-9a-f]{32})"`).exec(page)?.[1];
  assert.equal((await app.post(`${here}/cash/review`, { pick, kind: 'economic_performance', decision: 'exclude', reason: 'Service in January' })).status, 303);
  const review = async txn => { const { rows: [d] } = await pool.query('SELECT kind, decision, reason FROM cash_timing_review WHERE txn_id = $1', [txn]); return d ? [d.kind, d.decision, d.reason] : null; };
  assert.deepEqual(await review(perf), ['economic_performance', 'exclude', 'Service in January']);
  page = await (await app.get(`${here}/cash`)).text();
  fields = wholeFormFor(page, `${here}/cash/review`, `value="${perf}"`);
  assert.deepEqual([byName(fields).kind, byName(fields).decision, byName(fields).reason], ['economic_performance', 'exclude', 'Service in January'], 'the saved kind, decision and note');
  assert.equal((await sendForm(`${here}/cash/review`, fields)).status, 303);
  assert.deepEqual(await review(perf), ['economic_performance', 'exclude', 'Service in January'], 'an unchanged save keeps the exclusion');
  assert.equal((await sendForm(`${here}/cash/review`, fields.filter(([n]) => n !== 'reason'))).status, 303);
  assert.deepEqual(await review(perf), ['economic_performance', 'exclude', 'Service in January'], 'kept when the form omits the note');
  assert.equal((await app.post(`${here}/revisions`, {})).status, 303);
  const { rows: [n1] } = await pool.query('SELECT max(revision_no) AS n FROM tax_return_revision WHERE return_id = $1', [ret]);
  assert.equal((await sendForm(`${here}/cash/review`, fields, { reason: 'Service performed in January; invoice dated December' })).status, 303);
  assert.equal((await review(perf))[2], 'Service performed in January; invoice dated December', 'a deliberate edit applies');
  assert.equal((await app.post(`${here}/revisions`, {})).status, 303);
  const noteIn = async no => (await getRevision(pool, { ...S, returnId: ret, revisionNo: no })).inputs.decisions.find(d => d.txnId === perf)?.reason;
  assert.deepEqual([await noteIn(Number(n1.n)), await noteIn(Number(n1.n) + 1)], ['Service in January', 'Service performed in January; invoice dated December'], 'each revision holds the note of its time');
  assert.equal((await sendForm(`${here}/cash/review`, fields, { decision: 'include', reason: '' })).status, 303);
  assert.deepEqual(await review(perf), ['economic_performance', 'include', null], 'a deliberate change of decision, the note emptied on purpose');
  // A NEW decision's form offers no default decision: an unchanged save is refused rather than choosing one.
  const other = await bill(pool, S, '2025-12-23', [[id('Rent & Lease'), 300]]);
  page = await (await app.get(`${here}/cash`)).text();
  const pick2 = new RegExp(`<option value="(${other}:[0-9a-f]{32}:[0-9a-f]{32})"`).exec(page)?.[1];
  assert.equal((await app.post(`${here}/cash/review`, { pick: pick2, kind: 'related_party_accrual', decision: '', reason: '' })).status, 422);
  for (const t of [perf, other]) { await pool.query('DELETE FROM cash_timing_review WHERE txn_id = $1', [t]); await pool.query('DELETE FROM posting WHERE txn_id = $1', [t]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [t]); }
  // 3. A cash-method company's advance, included on its destination: the form shows the saved slot, decision and note.
  const C = { orgId: app.ids.orgId, entityId: await createCompany(pool, { orgId: app.ids.orgId, name: 'Rowan Cash Partners', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...C, fields: { ...profile, taxMethodDefault: 'cash' }, reason: 'test setup', actor: 'test' });
  const c25 = Number(await openPeriod(pool, { ...C, year: 2025, actor: 'test' }));
  const { rows: cRows } = await pool.query(`SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2 AND name = 'Checking'`, [C.orgId, C.entityId]);
  const adv = await payment(pool, C, '2025-12-01', 10000, Number(cRows[0].account_id));
  const R = { return_id: c25, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' };
  const cand = (await cashRecognition(pool, { orgId: C.orgId, ret: R })).candidates.find(x => x.txnId === adv);
  const cBase = `/tax/${C.entityId}/2025`;
  assert.equal((await app.post(`${cBase}/cash/review`, { txn_id: String(adv), txn_version: cand.txnVersion, event_version: cand.eventVersion, kind: 'unrestricted_advance', decision: 'include', slot_key: 'f1065.p1.1a|activity', amount: '100.00', reason: 'Deposit for January work' })).status, 303);
  const recognized = async () => (await cashRecognition(pool, { orgId: C.orgId, ret: R })).slotItems.map(x => [x.slotKey, x.cents]);
  assert.deepEqual(await recognized(), [['f1065.p1.1a|activity', -10000n]]);
  page = await (await app.get(`${cBase}/cash`)).text();
  fields = wholeFormFor(page, `${cBase}/cash/review`, `value="${adv}"`);
  assert.deepEqual(['kind', 'decision', 'slot_key', 'amount', 'reason'].map(n => byName(fields)[n]), ['unrestricted_advance', 'include', 'f1065.p1.1a|activity', '100.00', 'Deposit for January work']);
  assert.equal((await sendForm(`${cBase}/cash/review`, fields)).status, 303);
  assert.deepEqual([await recognized(), await review(adv)], [[['f1065.p1.1a|activity', -10000n]], ['unrestricted_advance', 'include', 'Deposit for January work']], 'an unchanged save keeps the inclusion, its destination and note');
  assert.equal((await sendForm(`${cBase}/cash/review`, fields, { kind: 'refundable_deposit', decision: 'exclude', slot_key: '', amount: '' })).status, 303);
  assert.deepEqual([await recognized(), (await review(adv)).slice(0, 2)], [[], ['refundable_deposit', 'exclude']], 'a deliberate change applies');
});

test('the movement form shows the SAVED class, stale too, so an unchanged save keeps it (Codex t3-plan-r7 R7-3): a transfer and an adjustment after a memo-only edit; a deliberate Purchase applies; the note kept when omitted, edited, cleared on purpose; each revision holds its note; a new movement asks instead of choosing Purchase', async () => {
  const { computeReturn } = await import('../lib/tax/engine/compute.js');
  const { getRevision } = await import('../lib/tax/engine/revision.js');
  const { activity, rawTxn, importedJe } = await import('./tax-t3-fixtures.js');
  const { saveWorkpaper } = await import('../lib/tax/cogs.js');
  const act = await activity(pool, S, { name: 'Larch trade' });
  const { rows } = await pool.query(`SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2 AND name IN ('Inventory Asset', 'Accounts Payable (A/P)', 'Checking')`, [S.orgId, S.entityId]);
  const id = n => Number(rows.find(r => r.name === n).account_id);
  const inv = id('Inventory Asset');
  const billTxn = await rawTxn(pool, S, 'bill', '2025-02-01', [[inv, 10000], [id('Accounts Payable (A/P)'), -10000]]);
  const adj = await importedJe(pool, S, '2025-06-30', [[inv, 500], [id('Checking'), -500]]);
  await saveBindings(pool, { ...S, returnId: ret, sourceEntityId: S.entityId, accountId: inv, measurement: 'activity', rows: [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: act }], actor: 'test' });
  await saveWorkpaper(pool, { ...S, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'test' });
  const purchases = async () => { const r = await computeReturn(pool, { ...S, returnId: ret }); const x = r.fields.find(f => f.key === `f1125a.main.2|activity=act:${act}|activity`); return [x?.cents ?? null, x?.status]; };
  const movementOf = (page, txn) => wholeFormFor(page, `${here}/cogs/movement`, `name="txn_id" value="${txn}"`);
  const byName = f => Object.fromEntries(f);
  const saved = async txn => { const { rows: [m] } = await pool.query('SELECT class, reason FROM tax_cogs_movement WHERE txn_id = $1', [txn]); return m ? [m.class, m.reason] : null; };
  // A NEW movement's form asks for the class: an unchanged save is refused rather than choosing Purchase.
  let page = await (await app.get(`${here}/cogs`)).text();
  let fields = movementOf(page, adj);
  assert.equal(byName(fields).class, '', 'no class chosen for a new movement');
  assert.equal((await sendForm(`${here}/cogs/movement`, fields)).status, 422);
  assert.equal((await sendForm(`${here}/cogs/movement`, fields, { class: 'adjustment', reason: 'Count correction' })).status, 303);
  fields = movementOf(page, billTxn);
  assert.equal((await sendForm(`${here}/cogs/movement`, fields, { class: 'transfer', reason: 'Stock moved between stores' })).status, 303);
  assert.deepEqual([await saved(billTxn), await saved(adj), await purchases()], [['transfer', 'Stock moved between stores'], ['adjustment', 'Count correction'], ['0', 'complete']]);
  // A memo-only edit makes both stale; the forms still show the saved classes, and an unchanged save keeps them.
  for (const t of [billTxn, adj]) await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [t]);
  assert.deepEqual(await purchases(), [null, 'unresolved'], 'stale: unknown');
  page = await (await app.get(`${here}/cogs`)).text();
  for (const [t, cls, note] of [[billTxn, 'transfer', 'Stock moved between stores'], [adj, 'adjustment', 'Count correction']]) {
    fields = movementOf(page, t);
    assert.deepEqual([byName(fields).class, byName(fields).reason], [cls, note], `${cls}: the saved class and note are shown while stale`);
    assert.equal((await sendForm(`${here}/cogs/movement`, fields)).status, 303);
    assert.deepEqual(await saved(t), [cls, note], `${cls}: an unchanged save keeps the class and the note`);
  }
  assert.deepEqual(await purchases(), ['0', 'complete'], 'reconfirmed as they were: no purchase admitted');
  // The note: kept when the form omits it, edited, cleared on purpose; the revisions hold each note of its time.
  page = await (await app.get(`${here}/cogs`)).text();
  fields = movementOf(page, billTxn);
  assert.equal((await sendForm(`${here}/cogs/movement`, fields.filter(([n]) => n !== 'reason'))).status, 303);
  assert.deepEqual(await saved(billTxn), ['transfer', 'Stock moved between stores'], 'kept when omitted');
  assert.equal((await app.post(`${here}/revisions`, {})).status, 303);
  const { rows: [n1] } = await pool.query('SELECT max(revision_no) AS n FROM tax_return_revision WHERE return_id = $1', [ret]);
  assert.equal((await sendForm(`${here}/cogs/movement`, fields, { reason: 'Stock moved to the second store in March' })).status, 303);
  assert.equal((await saved(billTxn))[1], 'Stock moved to the second store in March');
  assert.equal((await app.post(`${here}/revisions`, {})).status, 303);
  const noteIn = async no => (await getRevision(pool, { ...S, returnId: ret, revisionNo: no })).inputs.cogsClasses.find(c => c.txnId === billTxn)?.reason;
  assert.deepEqual([await noteIn(Number(n1.n)), await noteIn(Number(n1.n) + 1)], ['Stock moved between stores', 'Stock moved to the second store in March']);
  assert.equal((await sendForm(`${here}/cogs/movement`, fields, { reason: '' })).status, 303);
  assert.deepEqual(await saved(billTxn), ['transfer', null], 'emptied on purpose: cleared');
  // A deliberate Purchase is the person's choice, and changes the amount.
  assert.equal((await sendForm(`${here}/cogs/movement`, fields, { class: 'purchase', reason: '' })).status, 303);
  assert.deepEqual([await saved(billTxn), await purchases()], [['purchase', null], ['10000', 'complete']]);
  for (const t of [billTxn, adj]) { await pool.query('DELETE FROM tax_cogs_movement WHERE txn_id = $1', [t]); await pool.query('DELETE FROM posting WHERE txn_id = $1', [t]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [t]); }
  await pool.query('DELETE FROM tax_cogs_workpaper WHERE activity_id = $1', [act]);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [S.orgId, ret, inv]);
});
