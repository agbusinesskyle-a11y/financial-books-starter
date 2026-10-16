import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem } from '../lib/data/banking.js';
import { saveRule, deleteRule, listRules, ruleFits, ruleAction, suggestFor, learnedHistory, intentOf, acceptSuggestions, applyAutoRules, checkRule,
  exportRules, importRules } from '../lib/bankfeed/rules.js';
import { itemForm, picks } from './bank-forms.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { withTransaction } from '../lib/db.js';

// Bank review v2, stage BR-5: rules v2 — bank-text conditions, several accounts, split lines (fixed, then
// percentages), memo replace or append, Test (preview, with which rule wins), export and import.
let app, llDb, ll, feed, S, A, t;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, app.ids.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }] });
  await pullCompany(pool(), ll, S);
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `rv2-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, original_description, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, $7, 'active', 1)`, [feed.org, sampleUuid('rv2', key), llId(r.account), r.amount, r.date ?? '2026-10-12', r.description, r.original ?? null]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('rv2', k)])).rows[0].item_id));
  return ids;
}
const item = id => getBankItem(pool(), { ...S, itemId: id });
const rule = (fields) => saveRule(pool(), { ...S, actor, fields: { money: 'out', mode: 'suggest', ...fields } });
const posted = async id => (await pool().query(`SELECT p.account_id, p.amount_cents FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id
  WHERE k.item_id = $1 ORDER BY p.account_id, p.amount_cents`, [id])).rows.map(r => [Number(r.account_id), Number(r.amount_cents)]);
async function accept(id) {
  const it = await item(id);
  const s = await suggestFor(pool(), { ...S, item: it, rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
  return acceptSuggestions(pool(), { ...S, llAccountId: it.ll_account, itemIds: [id], intents: new Map([[id, intentOf(s, it)]]), actor });
}

test('a bank-text condition looks at the bank’s own description; several accounts', async () => {
  const r = await rule({ name: 'Netflix by bank text', conditions: [{ field: 'bank_text', op: 'contains', value: 'PPD ID 99887' }], accountId: A.office,
    llAccounts: [llId('Operating Checking'), llId('Business Card')] });
  const [chk, card, sav, other] = await bankSays([
    { account: 'Operating Checking', amount: '-15.49', description: 'NETFLIX', original: 'NETFLIX.COM 866-579-7172 CA PPD ID 99887' },
    { account: 'Business Card', amount: '-15.49', description: 'NETFLIX', original: 'NETFLIX.COM PPD ID 99887' },
    { account: 'Business Savings', amount: '-15.49', description: 'NETFLIX', original: 'NETFLIX.COM PPD ID 99887' },
    { account: 'Operating Checking', amount: '-15.49', description: 'NETFLIX PPD ID 99887', original: 'NETFLIX.COM' }]);
  const rr = (await listRules(pool(), S)).find(x => Number(x.rule_id) === r);
  assert.deepEqual(await Promise.all([chk, card, sav, other].map(async id => ruleFits(rr, await item(id)))), [true, true, false, false]);
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('a split rule: fixed amounts first, percentages share the rest, the last takes the rounding; accepted exactly as shown', async () => {
  const r = await rule({ name: 'Phone split', conditions: [{ field: 'description', op: 'contains', value: 'CELLCO' }],
    splits: [{ accountId: A.bank_fees, amount: '5.00', description: 'Fee' }, { accountId: A.office, percent: '60' }, { accountId: A.repairs, percent: '40' }],
    memo: 'Phones', memoMode: 'append' });
  const rr = (await listRules(pool(), S)).find(x => Number(x.rule_id) === r);
  const [a, small] = await bankSays([{ account: 'Business Card', amount: '-100.01', description: 'CELLCO PARTNERSHIP' }, { account: 'Business Card', amount: '-3.00', description: 'CELLCO FEE' }]);
  const act = ruleAction(rr, await item(a));
  assert.deepEqual(act.lines.map(l => [l.accountId, l.cents]), [[A.bank_fees, 500], [A.office, 5700], [A.repairs, 3801]]);
  assert.equal(act.memo, 'CELLCO PARTNERSHIP Phones');
  assert.equal(ruleFits(rr, await item(small)), false, 'the fixed $5.00 is more than the $3.00 charge');
  // The list shows the split; Accept records it.
  const list = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  assert.match(list, /Split: Bank Fees \$5\.00 · Office Supplies \$57\.00 · Repairs &amp; Maintenance \$38\.01/);
  const before = await t.snapshot();
  const out = await accept(a);
  assert.equal(out.accepted, 1);
  t.expectChange(before, await t.snapshot(), { accounts: { [A.card]: -10001, [A.bank_fees]: 500, [A.office]: 5700, [A.repairs]: 3801 }, net: -10001, label: 'split rule' });
  const { rows: [x] } = await pool().query('SELECT t.memo, e.basis, e.rule_id FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id JOIN bank_review_event e ON e.item_id = k.item_id WHERE k.item_id = $1', [a]);
  assert.deepEqual([x.memo, x.basis, Number(x.rule_id)], ['CELLCO PARTNERSHIP Phones', 'rule', r]);
  // The item page fills in every split line, and keeping them records the rule.
  const [b] = await bankSays([{ account: 'Business Card', amount: '-50.00', description: 'CELLCO PARTNERSHIP' }]);
  const f = await itemForm(app, b);
  assert.match(f.page, /value="Bank Fees"[\s\S]*?value="5\.00"[\s\S]*?value="Office Supplies"[\s\S]*?value="27\.00"[\s\S]*?value="Repairs &amp; Maintenance"[\s\S]*?value="18\.00"/);
  const body = new URLSearchParams([['cats_v', /name="cats_v" value="([^"]*)"/.exec(f.page)[1]], ['payees_v', /name="payees_v" value="([^"]*)"/.exec(f.page)[1]], ['rev', f.rev], ['evidence', f.evidence ?? ''], ['rule', /name="rule" value="(\d+)"/.exec(f.page)[1]], ['rule_at', /name="rule_at" value="([^"]+)"/.exec(f.page)[1]],
    ['line_account', 'Bank Fees'], ['line_amount', '5.00'], ['line_account', 'Office Supplies'], ['line_amount', '27.00'], ['line_account', 'Repairs & Maintenance'], ['line_amount', '18.00'],
    ['memo', 'CELLCO PARTNERSHIP Phones']]);
  assert.equal((await app.post(`/banking/item/${b}/add`, body)).status, 303);
  const { rows: [e] } = await pool().query(`SELECT basis, rule_id FROM bank_review_event WHERE item_id = $1 AND kind = 'added'`, [b]);
  assert.deepEqual([e.basis, Number(e.rule_id)], ['rule', r]);
  assert.deepEqual(await posted(b), [[A.card, -5000], [A.office, 2700], [A.repairs, 1800], [A.bank_fees, 500]].sort((p, q) => p[0] - q[0] || p[1] - q[1]));
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('an automatic split rule adds the split as items arrive', async () => {
  const r = await rule({ name: 'Auto split', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'SPLITCO' }],
    splits: [{ accountId: A.office, percent: '50' }, { accountId: A.repairs, percent: '50' }] });
  const [a] = await bankSays([{ account: 'Business Card', amount: '-20.01', description: 'SPLITCO' }]);
  await applyAutoRules(pool(), S);
  assert.deepEqual((await posted(a)).filter(([acc]) => acc !== A.card), [[A.office, 1000], [A.repairs, 1001]].sort((p, q) => p[0] - q[0]));
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('a split is checked: percentages to 100%, two lines or more, a percentage or an amount', async () => {
  const base = { name: 'Bad split', money: 'out', conditions: [{ field: 'description', op: 'contains', value: 'X' }] };
  const check = splits => checkRule(pool(), { ...S, fields: { ...base, splits } });
  await assert.rejects(check([{ accountId: A.office, percent: '60' }, { accountId: A.repairs, percent: '30' }]), /must come to 100%/);
  await assert.rejects(check([{ accountId: A.office, percent: '100' }]), /two lines or more/);
  await assert.rejects(check([{ accountId: A.office, percent: '50', amount: '5.00' }, { accountId: A.repairs, percent: '50' }]), /a percentage or an amount, not both/);
  await assert.rejects(check([{ accountId: A.office, amount: '5.00' }, { accountId: A.repairs, amount: '5.00' }]), /at least one percentage line/);
  const ok = await check([{ accountId: A.office, percent: '12.5' }, { accountId: A.repairs, percent: '87.5' }]);
  assert.deepEqual(ok.splits.map(s => s.percent), [1250, 8750]);
});

test('Test rule shows what it would catch, and which earlier rule is used instead — without saving', async () => {
  const first = await rule({ name: 'Shell first', priority: '10', conditions: [{ field: 'description', op: 'contains', value: 'SHELL' }], accountId: A.office });
  await bankSays([{ account: 'Business Card', amount: '-41.00', description: 'SHELL OIL 5521' }, { account: 'Business Card', amount: '-12.00', description: 'SHELL OIL CAR WASH' }]);
  const rulesBefore = (await listRules(pool(), S)).length;
  const res = await app.post('/banking/rules', new URLSearchParams([['name', 'Shell oil later'], ['priority', '50'], ['money', 'out'], ['matchAll', '1'],
    ['cond_field', 'description'], ['cond_op', 'contains'], ['cond_value', 'SHELL OIL'], ['cond_value2', ''], ['accountId', String(A.repairs)], ['mode', 'suggest'], ['active', '1'], ['test', '1']]));
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /What it would catch now/);
  assert.match(page, /SHELL OIL 5521/);
  assert.match(page, /Rule “Shell first” comes first, so it’s used instead/);
  assert.equal((await listRules(pool(), S)).length, rulesBefore, 'nothing saved');
  await deleteRule(pool(), { ...S, ruleId: first });
});

test('export and import: rules come back the same, by name; what doesn’t fit is skipped with the reason', async () => {
  const r1 = await rule({ name: 'Export one', conditions: [{ field: 'amount', op: 'between', value: '10.00', value2: '20.00' }, { field: 'bank_text', op: 'starts', value: 'ACH' }],
    accountId: A.office, llAccounts: [llId('Business Card')], memo: 'note', memoMode: 'append', priority: '7' });
  const r2 = await rule({ name: 'Export two', conditions: [{ field: 'description', op: 'contains', value: 'TWO' }],
    splits: [{ accountId: A.office, amount: '1.00' }, { accountId: A.repairs, percent: '100' }] });
  const exported = await exportRules(pool(), S);
  const res = await app.get('/banking/rules/export');
  assert.match(res.headers.get('content-disposition'), /bank-rules\.json/);
  const strip = rs => rs.filter(r => r.name.startsWith('Export')).map(r => ({ ...r, rule_id: undefined, created_at: undefined, updated_at: undefined, auto_added: undefined }));
  const was = strip(await listRules(pool(), S));
  await deleteRule(pool(), { ...S, ruleId: r1 });
  await deleteRule(pool(), { ...S, ruleId: r2 });
  const back = await importRules(pool(), { ...S, data: JSON.stringify(exported), actor });
  assert.ok(back.filter(x => x.name.startsWith('Export')).every(x => x.outcome === 'added'));
  assert.deepEqual(strip(await listRules(pool(), S)), was);
  // Again: the names are taken. And one naming a category this company doesn't have.
  const again = await importRules(pool(), { ...S, data: JSON.stringify({ ...exported, rules: [...exported.rules.filter(x => x.name === 'Export one'),
    { ...exported.rules.find(x => x.name === 'Export two'), name: 'Export three', split: null, category: { name: 'No Such Account', number: null } }] }), actor });
  assert.deepEqual(again.map(x => [x.name, x.outcome, x.reason]), [['Export one', 'skipped', 'A rule named “Export one” already exists'],
    ['Export three', 'skipped', 'this company has no category “No Such Account”']]);
  // Through the page: paste, see results.
  const page = await (await app.post('/banking/rules/import', new URLSearchParams({ data: 'not json' }))).text();
  assert.match(page, /isn’t valid JSON/);
});

test('export/import keeps a rule limited to an account not brought into the books; an unknown account skips the rule', async () => {
  const loan = feed.accounts.find(a => a.name === 'Equipment Loan').id;
  await saveMappings(pool(), { ...S, actor, choices: [{ id: loan, choice: String(A.equipment_loan) }] });
  const r = await rule({ name: 'Scope keeper', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'SCOPE KEEPER' }], accountId: A.office, llAccounts: [loan] });
  await saveMappings(pool(), { ...S, actor, choices: [{ id: loan, choice: 'skip' }] });
  const exported = await exportRules(pool(), S);
  const mine = exported.rules.find(x => x.name === 'Scope keeper');
  assert.equal(mine.accounts.length, 1);
  assert.equal(mine.accounts[0].books, null);
  await deleteRule(pool(), { ...S, ruleId: r });
  const back = await importRules(pool(), { ...S, data: JSON.stringify({ ...exported, rules: [mine] }), actor });
  assert.deepEqual(back.map(x => x.outcome), ['added']);
  const again = (await listRules(pool(), S)).find(x => x.name === 'Scope keeper');
  assert.deepEqual(again.ll_account_ids, [loan]);
  const skipped = await importRules(pool(), { ...S, data: JSON.stringify({ ...exported, rules: [{ ...mine, name: 'Scope nowhere', accounts: [{ books: null, feed: 'No Such Bank', mask: '0000' }] }] }), actor });
  assert.deepEqual(skipped.map(x => [x.outcome, x.reason]), [['skipped', 'this company has no bank account “No Such Bank ••0000”']]);
  await deleteRule(pool(), { ...S, ruleId: again.rule_id });
});

test('Test rule says when an existing books transaction would be matched instead', async () => {
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnDate: '2026-10-12', accountId: A.card, memo: 'already',
    categoryLines: [{ accountId: A.office, amount: '13.79' }], itemLines: [] }));
  await bankSays([{ account: 'Business Card', amount: '-13.79', description: 'PREVIEW HOLD' }]);
  const res = await app.post('/banking/rules', new URLSearchParams([['name', 'Preview hold'], ['priority', '100'], ['money', 'out'], ['matchAll', '1'],
    ['cond_field', 'description'], ['cond_op', 'contains'], ['cond_value', 'PREVIEW HOLD'], ['cond_value2', ''], ['accountId', String(A.repairs)], ['mode', 'auto'], ['active', '1'], ['test', '1']]));
  assert.match(await res.text(), /Not recorded: it matches what’s already in the books/);
});

test('import falls back to the bank’s name and last digits when the books account is gone; Test shows an Undo hold', async () => {
  const loan = feed.accounts.find(a => a.name === 'Equipment Loan').id;
  await saveMappings(pool(), { ...S, actor, choices: [{ id: loan, choice: String(A.equipment_loan) }] });
  const r = await rule({ name: 'Fallback scope', conditions: [{ field: 'description', op: 'contains', value: 'FALLBACK SCOPE' }], accountId: A.office, llAccounts: [loan] });
  const exported = await exportRules(pool(), S);
  const mine = exported.rules.find(x => x.name === 'Fallback scope');
  assert.equal(mine.accounts[0].books, 'Equipment Loan');
  await deleteRule(pool(), { ...S, ruleId: r });
  await saveMappings(pool(), { ...S, actor, choices: [{ id: loan, choice: 'skip' }] });
  const back = await importRules(pool(), { ...S, data: JSON.stringify({ ...exported, rules: [mine] }), actor });
  assert.deepEqual(back.map(x => x.outcome), ['added']);
  assert.deepEqual((await listRules(pool(), S)).find(x => x.name === 'Fallback scope').ll_account_ids, [loan]);
  // A person undid the item: an automatic rule's Test says it won't add it.
  const [id] = await bankSays([{ account: 'Business Card', amount: '-75.81', description: 'PREVIEW UNDONE HOLD' }]);
  let f = await itemForm(app, id);
  await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['evidence', f.evidence ?? ''], ['line_account', 'Office Supplies'], ['line_amount', '']]));
  f = await itemForm(app, id);
  await app.post(`/banking/item/${id}/undo`, new URLSearchParams({ plan: f.plan }));
  const res = await app.post('/banking/rules', new URLSearchParams([['name', 'Undone hold'], ['priority', '100'], ['money', 'out'], ['matchAll', '1'],
    ['cond_field', 'description'], ['cond_op', 'contains'], ['cond_value', 'PREVIEW UNDONE HOLD'], ['cond_value2', ''], ['accountId', String(A.repairs)], ['mode', 'auto'], ['active', '1'], ['test', '1']]));
  assert.match(await res.text(), /Not added automatically: a person undid it/);
});

test('an unchanged split rule posted from the item page keeps the rule’s class on every line', async () => {
  const accounting = more => app.post('/settings/accounting', new URLSearchParams({ ...{ fiscalStartMonth: '1', method: 'accrual', dateFormat: 'mdy', showAccountNumbers: '1', classesOn: '1', classMode: 'line', locationsOn: '', locationLabel: 'Location', billableOn: '', billableMarkup: '0', billableIncomeAccountId: '', autoApplyCustomer: '', autoApplyVendor: '', warnDuplicateBills: '1' }, ...more }));
  assert.equal((await accounting({})).status, 303);
  const cls = Number((await pool().query(`INSERT INTO class (org_id, entity_id, name) VALUES ($1, $2, 'Rule split class') RETURNING class_id`, [S.orgId, S.entityId])).rows[0].class_id);
  const r = await rule({ name: 'Split class', conditions: [{ field: 'description', op: 'contains', value: 'RULE SPLIT CLASS' }], classId: cls,
    splits: [{ accountId: A.office, percent: '40' }, { accountId: A.repairs, percent: '60' }] });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-123.47', description: 'RULE SPLIT CLASS' }]);
  const f = await itemForm(app, id);
  // The served form, as it is: every field and selected option.
  const body = new URLSearchParams();
  const form = /<form method="post" action="\/banking\/item\/\d+\/add"[\s\S]*?<\/form>/.exec(f.page)[0];
  for (const m of form.matchAll(/<input(?: type="hidden")? name="([^"]+)"[^>]*? value="([^"]*)"/g)) body.append(m[1], m[2].replace(/&amp;/g, '&'));
  for (const m of form.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/g)) body.append(m[1], /<option value="([^"]*)" selected>/.exec(m[2])?.[1] ?? '');
  body.set('csrf', app.csrf);
  assert.equal((await app.raw(`/banking/item/${id}/add`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 303);
  const { rows } = await pool().query(`SELECT p.account_id, p.class_id FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1 AND p.account_id IN ($2, $3)`,
    [id, A.office, A.repairs]);
  assert.deepEqual(rows.map(x => Number(x.class_id)), [cls, cls]);
  await accounting({ classesOn: '', classMode: 'txn' });
  await deleteRule(pool(), { ...S, ruleId: r });
});
