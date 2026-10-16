import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout, TODAY } from './tieout.js';
import { createCompany } from '../lib/data/companies.js';
import { saveAccount, listAccounts, ledgerCheck, deleteAccount } from '../lib/data/ledger.js';
import { saveVendorDoc } from '../lib/data/payables.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { listLoans, saveLoanPayment, saveLoanSetup, paymentDefaults } from '../lib/data/loans.js';
import { canAccess } from '../lib/domain/roles.js';
import { appNav, GROUPS, SOON } from '../lib/views/nav.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { addItem } from '../lib/data/banking.js';

// The Loans page: every loan and line of credit with its ledger balance and last payment; a loan payment that
// posts exactly the bank amount split into principal and interest; a split that doesn't add up refused; and a loan between
// two companies of one organization shown from both sides, paired by a person (never by name).
let app, pool, t, A, S, B, llDb, ll, feed;
const actor = 'tester';
const accountId = async (scope, name) => (await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [scope.orgId, scope.entityId, name])).rows[0].account_id;
const je = (scope, debitId, creditId, amount, memo) => saveJournalEntry(pool, { ...scope, actor, txnDate: '2026-09-01', docNumber: '', memo, lines: [
  { accountId: String(debitId), debit: amount, credit: '' }, { accountId: String(creditId), debit: '', credit: amount }] });
const newAccount = (scope, name, number, type) => saveAccount(pool, { ...scope, fields: { name, number, type, parentId: '', description: '', active: true } });
const errorOf = async res => (/role="alert">([^<]*)</.exec(await res.clone().text()) ?? [])[1] ?? '';
const txns = async () => Number((await pool.query('SELECT count(*)::int AS n FROM txn WHERE org_id = $1', [S.orgId])).rows[0].n);
let lineOfCredit, salesTax, loanToB, bLoan, bChecking, bInterest;

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll });
  pool = app.db.pool;
  A = app.ids.accounts;
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  t = tieout(app);
  // The equipment loan was borrowed; a line of credit drawn; sales tax owed (a liability, not a loan); money lent to company B.
  await je(S, A.equipment, A.equipment_loan, '20000.00', 'Equipment loan');
  lineOfCredit = await newAccount(S, 'Line of Credit', '2400', 'other_current_liability');
  salesTax = await newAccount(S, 'Sales Tax Payable', '2300', 'other_current_liability');
  loanToB = await newAccount(S, 'Loan to Second Ranch', '1450', 'other_current_asset');
  await je(S, A.checking, lineOfCredit, '3000.00', 'Draw');
  await je(S, A.checking, salesTax, '125.00', 'Sales tax collected');
  await je(S, loanToB, A.checking, '5000.00', 'Lent to Second Ranch');
  // Company B, in the same organization, borrowed the 5,000 on its standard Loan Payable.
  B = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Second Ranch', timeZone: 'America/Chicago' }) };
  bLoan = await accountId(B, 'Loan Payable');
  bChecking = await accountId(B, 'Checking');
  bInterest = await accountId(B, 'Interest Paid');
  await je(B, bChecking, bLoan, '5000.00', 'Borrowed from the sample company');
});
after(async () => {
  for (const scope of [S, B]) {
    const c = await ledgerCheck(pool, scope);
    assert.ok(c.balanced && c.arMatches && c.apMatches, JSON.stringify(c));
  }
  await app.close();
  await llDb.drop();
});

test('the Loans page lists every loan and line of credit with its balance from the ledger', async () => {
  const companies = [{ entityId: S.entityId, name: 'A' }, { entityId: B.entityId, name: 'Second Ranch' }];
  const loans = await listLoans(pool, { ...S, companies });
  const by = new Map(loans.map(l => [l.accountId, l]));
  assert.deepEqual([...by.keys()].sort(), [A.equipment_loan, lineOfCredit, loanToB].sort(), 'loans, the line of credit and the loan to others; not sales tax');
  assert.equal(by.get(A.equipment_loan).kind, 'Loan');
  assert.equal(by.get(lineOfCredit).kind, 'Line of credit');
  assert.equal(by.get(loanToB).kind, 'Loan receivable');
  assert.equal(by.get(loanToB).payable, false);
  // The same balance as the chart of accounts and the balance sheet.
  const chart = new Map((await listAccounts(pool, S)).map(a => [a.account_id, a.balance_cents]));
  const bs = await t.run('balance_sheet', { period: 'today' });
  const bsRow = id => bs.rows.find(r => r.kind === 'account' && r.accountId === id).values.at(-1);
  for (const l of loans) {
    assert.equal(l.balance, chart.get(l.accountId), `${l.name} = chart of accounts`);
    assert.equal(Math.abs(l.balance), Math.abs(bsRow(l.accountId)), `${l.name} = balance sheet`);
  }
  assert.equal(by.get(A.equipment_loan).balance, 2_000_000);
  assert.equal(by.get(loanToB).balance, 500_000);
  // Not paired by name, though "Second Ranch" is a company and B's Loan Payable has the same balance.
  assert.equal(by.get(loanToB).other, null);
  // Nothing paid yet: the draw and the borrowing aren't payments.
  assert.equal(by.get(A.equipment_loan).last, null);
  const body = await (await app.get('/loans')).text();
  for (const s of ['Equipment Loan', 'Line of Credit', 'Loan to Second Ranch', '$20,000.00', '$3,000.00', '$5,000.00', 'href="/loans/pay"', `href="/settings/accounts/${A.equipment_loan}"`,
    `account=${A.equipment_loan}`]) assert.ok(body.includes(s), `page shows ${s}`);
  assert.doesNotMatch(body, /Sales Tax Payable<\/strong>/);
});

test('a loan payment posts exactly the bank amount: principal off the loan, interest to expense, the bank down', async () => {
  t.checkTied(await t.snapshot(), 'before');
  const lender = app.ids.vendors.repair;
  const pay = extra => app.post('/loans/pay', { loan: String(A.equipment_loan), bank: String(A.checking), vendor: String(lender), txn_date: TODAY, check_no: '',
    total: '1,074.51', principal: '1000.00', interest: '74.51', interest_account: String(A.interest_expense), memo: 'October payment', ...extra });
  let a = await t.snapshot();
  let res = await pay();
  assert.equal(res.status, 303, await errorOf(res));
  assert.equal(res.headers.get('location'), '/loans');
  let b = await t.snapshot();
  t.checkTied(b, 'payment');
  t.expectChange(a, b, { label: 'payment', accounts: { [A.checking]: -107_451, [A.equipment_loan]: 100_000, [A.interest_expense]: 7_451 }, net: -7_451 });
  const { rows: [x] } = await pool.query(`SELECT txn_id, type, total_cents, vendor_id, account_id FROM txn WHERE org_id = $1 AND entity_id = $2 ORDER BY txn_id DESC LIMIT 1`, [S.orgId, S.entityId]);
  assert.equal(x.type, 'expense', 'an expense from the bank, the way QuickBooks books it');
  assert.equal(Number(x.total_cents), 107_451);
  assert.equal(x.vendor_id, lender);
  await t.expectHistory(x.txn_id);
  // The list shows it as the last payment, with what came off the balance.
  let loan = (await listLoans(pool, { ...S, companies: [] })).find(l => l.accountId === A.equipment_loan);
  assert.equal(loan.balance, 1_900_000);
  assert.deepEqual({ txnId: loan.last.txnId, paid: loan.last.paid, principal: loan.last.principal, date: loan.last.date },
    { txnId: x.txn_id, paid: 107_451, principal: 100_000, date: TODAY });
  // The next payment starts from the last one: the bank, the lender, the interest account and the amount.
  const form = await (await app.get(`/loans/pay?loan=${A.equipment_loan}`)).text();
  assert.match(form, new RegExp(`<option value="${A.checking}" selected`));
  assert.match(form, new RegExp(`<option value="${lender}" selected`));
  assert.match(form, new RegExp(`<option value="${A.interest_expense}" selected`));
  assert.match(form, /name="total" value="1074.51"/);

  // A check, with an escrow line: still exactly what left the bank.
  a = await t.snapshot();
  res = await pay({ check_no: '7001', total: '1,094.51', extra_account: String(A.insurance), extra_amount: '20.00', extra_desc: 'Escrow' });
  assert.equal(res.status, 303, await errorOf(res));
  b = await t.snapshot();
  t.checkTied(b, 'check payment');
  t.expectChange(a, b, { label: 'check payment', accounts: { [A.checking]: -109_451, [A.equipment_loan]: 100_000, [A.interest_expense]: 7_451, [A.insurance]: 2_000 }, net: -9_451 });
  const { rows: [c] } = await pool.query(`SELECT type, doc_number FROM txn WHERE org_id = $1 AND entity_id = $2 ORDER BY txn_id DESC LIMIT 1`, [S.orgId, S.entityId]);
  assert.deepEqual({ ...c }, { type: 'check', doc_number: '7001' });
  loan = (await listLoans(pool, { ...S, companies: [] })).find(l => l.accountId === A.equipment_loan);
  assert.equal(loan.balance, 1_800_000);
  assert.ok((await (await app.get('/loans')).text()).includes('$18,000.00'));
});

test('a split that doesn’t add up, or isn’t a loan payment, is refused and nothing posts', async () => {
  const n = await txns();
  const base = { loan: String(A.equipment_loan), bank: String(A.checking), vendor: '', txn_date: TODAY, check_no: '', total: '1000.00', principal: '900.00', interest: '50.00',
    interest_account: String(A.interest_expense), memo: '' };
  const refused = async (body, message) => {
    const res = await app.post('/loans/pay', { ...base, ...body });
    assert.equal(res.status, 422);
    assert.equal(await errorOf(res), message);
  };
  await refused({}, 'The split adds up to $950.00; the payment is $1,000.00.');
  await refused({ principal: '960.00' }, 'The split adds up to $1,010.00; the payment is $1,000.00.');
  await refused({ interest_account: '' }, 'Choose the expense account the interest goes to.');
  await refused({ principal: '950.00', loan: String(loanToB) }, 'Choose the loan being paid.');
  await refused({ principal: '950.00', bank: String(A.card) }, 'Choose the bank account the payment came from.');
  await refused({ principal: '950.00', total: '' }, 'Enter the amount that left the bank, like 1,074.51.');
  await refused({ principal: '940.00', extra_account: '', extra_amount: '10.00' }, 'Other line 1: choose the account and enter the amount (escrow, a late fee…).');
  // The form comes back with what was typed.
  const res = await app.post('/loans/pay', base);
  assert.match(await res.text(), /name="principal" value="900.00"/);
  // Another company's loan can't be paid from this one.
  await assert.rejects(saveLoanPayment(pool, { ...S, actor, v: { ...base, loanId: bLoan, bankId: A.checking, txnDate: TODAY, interestAccountId: A.interest_expense, principal: '950.00' } }),
    /Choose the loan being paid/);
  assert.equal(await txns(), n, 'nothing posted');
  t.checkTied(await t.snapshot(), 'after refusals');
});

test('a loan between two companies: both balances side by side, and whether they agree', async () => {
  const both = [{ entityId: S.entityId, name: 'Sample' }, { entityId: B.entityId, name: 'Second Ranch' }];
  const openIds = both.map(c => c.entityId);
  // Paired by a person on the loan's setup (admins), never by name.
  let res = await app.post(`/loans/${loanToB}/setup`, { list: '', other_account: String(bLoan) });
  assert.equal(res.status, 303, await errorOf(res));
  let mine = (await listLoans(pool, { ...S, companies: both })).find(l => l.accountId === loanToB);
  assert.deepEqual({ company: mine.other.company, name: mine.other.name, balance: mine.other.balance, agrees: mine.other.agrees }, { company: 'Second Ranch', name: 'Loan Payable', balance: 500_000, agrees: true });
  let body = await (await app.get('/loans')).text();
  assert.ok(body.includes('Second Ranch · 2500 · Loan Payable: $5,000.00'), 'other side shown');
  assert.ok(body.includes('Both sides agree'));
  // B pays 600 (500 principal): B's books move, A's haven't yet, so the two are off by 500.
  await saveLoanPayment(pool, { ...B, actor, v: { loanId: bLoan, bankId: bChecking, txnDate: TODAY, total: '600.00', principal: '500.00', interest: '100.00', interestAccountId: bInterest } });
  mine = (await listLoans(pool, { ...S, companies: both })).find(l => l.accountId === loanToB);
  assert.deepEqual({ balance: mine.other.balance, agrees: mine.other.agrees, difference: mine.other.difference }, { balance: 450_000, agrees: false, difference: 50_000 });
  assert.ok((await (await app.get('/loans')).text()).includes('Off by $500.00'));
  // From B's side the same pairing shows (it's kept on A's account).
  assert.equal((await app.post('/company/switch', { entity_id: String(B.entityId) })).status, 303);
  body = await (await app.get('/loans')).text();
  assert.ok(body.includes('Loan to Second Ranch: $5,000.00') && body.includes('Off by $500.00'), 'B sees A’s side');
  assert.match(await (await app.get(`/loans/${bLoan}/setup`)).text(), new RegExp(`<option value="${loanToB}" selected`));
  assert.equal((await app.post('/company/switch', { entity_id: String(S.entityId) })).status, 303);
  // A's books catch up (B's payment deposited): they agree again.
  await je(S, A.checking, loanToB, '500.00', 'Paid back by Second Ranch');
  mine = (await listLoans(pool, { ...S, companies: both })).find(l => l.accountId === loanToB);
  assert.equal(mine.other.agrees, true);
  // Someone who can't open B sees that it's paired, not B's numbers.
  mine = (await listLoans(pool, { ...S, companies: [both[0]] })).find(l => l.accountId === loanToB);
  assert.deepEqual(mine.other, { hidden: true });

  // Refused: the same side of the books, an account of the same company, a company the person can't open, one already paired.
  await assert.rejects(saveLoanSetup(pool, { ...S, accountId: A.equipment_loan, list: '', otherAccountId: bLoan, openEntityIds: openIds }), /other side of the books: an asset/);
  await assert.rejects(saveLoanSetup(pool, { ...S, accountId: loanToB, list: '', otherAccountId: A.equipment_loan, openEntityIds: openIds }), /another of your companies/);
  await assert.rejects(saveLoanSetup(pool, { ...S, accountId: loanToB, list: '', otherAccountId: bLoan, openEntityIds: [S.entityId] }), /another of your companies/);
  const second = await newAccount(S, 'Loan to Second Ranch 2', '1451', 'other_current_asset');
  await assert.rejects(saveLoanSetup(pool, { ...S, accountId: second, list: '', otherAccountId: bLoan, openEntityIds: openIds }), /already the other side of “Loan to Second Ranch”/);
  res = await app.post(`/loans/${second}/setup`, { list: '', other_account: String(bLoan) });
  assert.equal(res.status, 422);
  // Pairing from B's side to the same account it's already paired with keeps one pairing; clearing it from B clears it.
  await saveLoanSetup(pool, { ...B, accountId: bLoan, list: '', otherAccountId: loanToB, openEntityIds: openIds });
  assert.equal((await listLoans(pool, { ...S, companies: both })).find(l => l.accountId === loanToB).other.accountId, bLoan);
  await saveLoanSetup(pool, { ...B, accountId: bLoan, list: '', otherAccountId: null, openEntityIds: openIds });
  assert.equal((await listLoans(pool, { ...S, companies: both })).find(l => l.accountId === loanToB).other, null);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM account WHERE org_id = $1 AND loan_other_account_id IS NOT NULL', [S.orgId]);
  assert.equal(rows[0].n, 0);
});

test('an account can be put on the list or taken off it', async () => {
  let res = await app.post(`/loans/${salesTax}/setup`, { list: 'show', other_account: '' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await app.post(`/loans/${lineOfCredit}/setup`, { list: 'hide', other_account: '' });
  assert.equal(res.status, 303, await errorOf(res));
  const ids = (await listLoans(pool, { ...S, companies: [] })).map(l => l.accountId);
  assert.ok(ids.includes(salesTax) && !ids.includes(lineOfCredit));
  // The list's "Another account" offers what isn't listed; a bank account can't be set up.
  const body = await (await app.get('/loans')).text();
  assert.match(body, new RegExp(`<option value="${lineOfCredit}">`));
  assert.equal((await app.get(`/loans/${A.checking}/setup`)).status, 404);
  assert.equal((await app.get(`/loans/setup?account=${lineOfCredit}`)).headers.get('location'), `/loans/${lineOfCredit}/setup`);
  for (const id of [salesTax, lineOfCredit]) await saveLoanSetup(pool, { ...S, accountId: id, list: '', otherAccountId: null, openEntityIds: [S.entityId] });
});

test('menu: Lending is one Loans page; who can see it and who can record', async () => {
  const lending = GROUPS.find(g => g.key === 'lending');
  assert.deepEqual(lending.items.map(i => [i.label, i.href]), [['Loans', '/loans']]);
  for (const slug of ['lending', 'loans', 'line-of-credit']) {
    assert.ok(!Object.hasOwn(SOON, slug), `no Soon page for ${slug}`);
    const res = await app.get(`/soon/${slug}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/loans');
  }
  // Like the other accounting pages: admins and standard users see and record; reports-only people look; customers-only and
  // vendors-only people don't. Pairing and listing accounts is an account setting: admins only.
  for (const [role, see, record, setup] of [['admin', true, true, true], ['standard', true, true, false], ['reports', true, false, false],
    ['customers', false, false, false], ['vendors', false, false, false]]) {
    assert.equal(canAccess(role, 'GET', '/loans'), see, `${role} sees`);
    assert.equal(canAccess(role, 'GET', '/loans/pay'), see, `${role} opens the form`);
    assert.equal(canAccess(role, 'POST', '/loans/pay'), record, `${role} records`);
    assert.equal(canAccess(role, 'GET', '/loans/12/setup') && canAccess(role, 'POST', '/loans/12/setup') && canAccess(role, 'GET', '/loans/setup'), setup, `${role} sets up`);
    const nav = appNav({ role, can: p => canAccess(role, 'GET', p), path: '/home', search: '', title: 'Home', csrf: 'x', entityName: 'Co', bookmarks: [], pins: undefined });
    assert.equal(String(nav.panel).includes('href="/loans"'), see, `${role} menu`);
  }
  assert.ok((await app.get('/loans/pay')).status === 200);
});

test('bank review: a loan payment line split between the loan and the interest posts the same way', async () => {
  feed = await buildSampleFeed(pool, { ...S, asOf: TODAY });
  await writeLedgerlineSample(ll, feed);
  const llId = name => feed.accounts.find(a => a.name === name).id;
  await pool.query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool, ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool, ll, S);
  await saveMappings(pool, { ...S, actor, choices: [{ id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: 'skip' },
    { id: llId('Business Card'), choice: 'skip' }, { id: llId('Equipment Loan'), choice: String(A.equipment_loan) }] });
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, '-1074.51', 'USD', $4, false, 'AUTOMATIC LOAN PMT *0012', 'active', 1)`, [feed.org, sampleUuid('test', 'loan-pmt'), llId('Operating Checking'), TODAY]);
  await pullCompany(pool, ll, S);
  const itemId = (await pool.query(`SELECT item_id FROM bank_feed_item WHERE entity_id = $1 AND description = 'AUTOMATIC LOAN PMT *0012'`, [S.entityId])).rows[0].item_id;
  const a = await t.snapshot();
  await assert.rejects(addItem(pool, { ...S, itemId, actor, separate: true, lines: [{ accountId: A.equipment_loan, amount: '1000.00' }, { accountId: A.interest_expense, amount: '70.00' }] }),
    /split adds up to \$1,070\.00; the bank shows \$1,074\.51/);
  const txnId = await addItem(pool, { ...S, itemId, actor, separate: true, lines: [{ accountId: A.equipment_loan, amount: '1000.00' }, { accountId: A.interest_expense, amount: '74.51' }] });
  const b = await t.snapshot();
  t.checkTied(b, 'bank split');
  t.expectChange(a, b, { label: 'bank split', accounts: { [A.checking]: -107_451, [A.equipment_loan]: 100_000, [A.interest_expense]: 7_451 }, net: -7_451 });
  assert.equal((await pool.query('SELECT type FROM txn WHERE txn_id = $1', [txnId])).rows[0].type, 'expense', 'the same expense the Loans form writes');
  const loan = (await listLoans(pool, { ...S, companies: [] })).find(l => l.accountId === A.equipment_loan);
  assert.equal(loan.last.txnId, txnId);
});

// ---- Codex review of 5af06a2 ----

test('refusing a pairing never names an account in a company the person can’t open (review #1)', async () => {
  const C = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Third Hidden Co', timeZone: 'America/Chicago' }) };
  const cLent = await newAccount(C, 'Secret Loan to Second Ranch', '1460', 'other_current_asset');
  const all = [S.entityId, B.entityId, C.entityId];
  await saveLoanSetup(pool, { ...C, accountId: cLent, list: '', otherAccountId: bLoan, openEntityIds: all });
  // Someone who can open this company and B but not C: told it's paired, never with what.
  const err = await saveLoanSetup(pool, { ...S, accountId: loanToB, list: '', otherAccountId: bLoan, openEntityIds: [S.entityId, B.entityId] }).catch(e => e);
  assert.equal(err.message, '“Loan Payable” in Second Ranch is already paired with an account in another company. Change that one first.');
  assert.doesNotMatch(err.message, /Secret|Third Hidden/);
  // Over HTTP the owner can open every company, so they're told which one.
  const res = await app.post(`/loans/${loanToB}/setup`, { list: '', other_account: String(bLoan) });
  assert.equal(res.status, 422);
  assert.equal(await errorOf(res), '“Loan Payable” in Second Ranch is already the other side of “Secret Loan to Second Ranch” in Third Hidden Co. Change that one first.');
  // Nor can it be unpaired from B by someone who can't open C.
  await assert.rejects(saveLoanSetup(pool, { ...B, accountId: bLoan, list: '', otherAccountId: null, openEntityIds: [S.entityId, B.entityId] }), /a company you can’t open\. Ask/);
  // A paired account can't be deleted until it's unpaired.
  await assert.rejects(deleteAccount(pool, { ...C, accountId: cLent }), /paired with a loan in another company/);
  await saveLoanSetup(pool, { ...C, accountId: cLent, list: '', otherAccountId: null, openEntityIds: all });
  await deleteAccount(pool, { ...C, accountId: cLent });
});

test('the interest account is filled in only when it’s surely the interest account (review #2)', async () => {
  // The last payment had an Insurance line before its Interest line.
  await saveVendorDoc(pool, { ...S, actor, type: 'expense', txnDate: TODAY, accountId: A.checking, vendorId: null, memo: 'Insurance first', itemLines: [], categoryLines: [
    { accountId: String(A.insurance), amount: '15.00' }, { accountId: String(A.equipment_loan), amount: '900.00' }, { accountId: String(A.interest_expense), amount: '60.00' }] });
  let d = await paymentDefaults(pool, { ...S, loanId: A.equipment_loan });
  assert.equal(d.interestAccountId, A.interest_expense);
  assert.match(await (await app.get(`/loans/pay?loan=${A.equipment_loan}`)).text(), new RegExp(`<option value="${A.interest_expense}" selected`));
  // A last payment with no interest line: the company's one interest expense account…
  await saveVendorDoc(pool, { ...S, actor, type: 'expense', txnDate: TODAY, accountId: A.checking, vendorId: null, memo: 'No interest', itemLines: [], categoryLines: [
    { accountId: String(A.insurance), amount: '15.00' }, { accountId: String(A.equipment_loan), amount: '900.00' }] });
  d = await paymentDefaults(pool, { ...S, loanId: A.equipment_loan });
  assert.equal(d.interestAccountId, A.interest_expense);
  // …but with two of them, nothing: the person chooses.
  await newAccount(S, 'Interest - Truck', '8020', 'other_expense');
  d = await paymentDefaults(pool, { ...S, loanId: A.equipment_loan });
  assert.equal(d.interestAccountId, null);
  const form = await (await app.get(`/loans/pay?loan=${A.equipment_loan}`)).text();
  assert.doesNotMatch(form, new RegExp(`<option value="${A.insurance}" selected`));
  assert.doesNotMatch(form, new RegExp(`<option value="${A.interest_expense}" selected`));
});

test('pairings saved at once leave every loan with one counterpart that names it back (review #3)', async () => {
  const all = [S.entityId, B.entityId];
  const bLent = await newAccount(B, 'Loan to the sample company', '1470', 'other_current_asset');
  const aOwed = await newAccount(S, 'Loan from Second Ranch', '2550', 'long_term_liability');
  const pairs = async () => (await pool.query('SELECT account_id, loan_other_account_id FROM account WHERE org_id = $1 AND loan_other_account_id IS NOT NULL', [S.orgId])).rows;
  const check = async () => {
    const by = new Map((await pairs()).map(r => [r.account_id, r.loan_other_account_id]));
    for (const [x, y] of by) assert.equal(by.get(y), x, `${x} → ${y} is named back`);
    assert.equal(new Set(by.values()).size, by.size, 'one counterpart each');
  };
  for (let i = 0; i < 5; i++) {
    const aOther = await newAccount(S, `Loan to Second Ranch r${i}`, `148${i}`, 'other_current_asset');
    // B's payable claimed by two of A's receivables at once, and one pair saved from both sides at once.
    const r = await Promise.allSettled([
      saveLoanSetup(pool, { ...S, accountId: loanToB, list: '', otherAccountId: bLoan, openEntityIds: all }),
      saveLoanSetup(pool, { ...B, accountId: bLoan, list: '', otherAccountId: aOther, openEntityIds: all }),
      saveLoanSetup(pool, { ...B, accountId: bLent, list: '', otherAccountId: aOwed, openEntityIds: all }),
      saveLoanSetup(pool, { ...S, accountId: aOwed, list: '', otherAccountId: bLent, openEntityIds: all })]);
    for (const x of r) if (x.status === 'rejected') assert.equal(x.reason.constructor.name, 'ValidationError', x.reason.stack);
    await check();
    for (const x of await pairs()) await pool.query('UPDATE account SET loan_other_account_id = NULL WHERE account_id = ANY($1)', [[x.account_id, x.loan_other_account_id]]);
  }
  // The database itself refuses a pairing that isn't named back, or a second account naming the same one.
  await assert.rejects(pool.query('UPDATE account SET loan_other_account_id = $2 WHERE account_id = $1', [loanToB, bLoan]), /account_loan_pair_back/);
  await saveLoanSetup(pool, { ...S, accountId: loanToB, list: '', otherAccountId: bLoan, openEntityIds: all });
  await assert.rejects(pool.query('UPDATE account SET loan_other_account_id = $2 WHERE account_id = $1', [aOwed, loanToB]), /account_loan_other|account_loan_pair_back/);
  await check();
  await saveLoanSetup(pool, { ...S, accountId: loanToB, list: '', otherAccountId: null, openEntityIds: all });
  assert.deepEqual(await pairs(), []);
});

test('plural names count: “Lines of credit”, “Notes payable” are listed and can be paid (review #4)', async () => {
  const lines = await newAccount(S, 'Lines of credit', '2410', 'other_current_liability');
  const notes = await newAccount(S, 'Notes payable', '2420', 'other_current_liability');
  const lenderNamed = await newAccount(S, 'Greenback Valley Ranch', '2430', 'other_current_liability');
  await je(S, A.checking, lines, '3000.00', 'Draw on the lines');
  await je(S, A.checking, notes, '800.00', 'Note');
  await je(S, A.checking, lenderNamed, '4000.00', 'Borrowed from a ranch');
  let by = new Map((await listLoans(pool, { ...S, companies: [] })).map(l => [l.accountId, l]));
  assert.equal(by.get(lines)?.kind, 'Line of credit');
  assert.equal(by.get(lines).balance, 300_000);
  assert.equal(by.get(notes)?.kind, 'Loan');
  assert.ok(!by.has(lenderNamed), 'named after the lender: not listed on its own…');
  const page = await (await app.get('/loans')).text();
  assert.match(page, new RegExp(`<option value="${lenderNamed}">`), '…but offered under Another account');
  assert.ok(page.includes('set it to “Always listed”'), 'the page says how');
  assert.equal((await app.post(`/loans/${lenderNamed}/setup`, { list: 'show', other_account: '' })).status, 303);
  by = new Map((await listLoans(pool, { ...S, companies: [] })).map(l => [l.accountId, l]));
  assert.equal(by.get(lenderNamed)?.balance, 400_000);
  const form = await (await app.get('/loans/pay')).text();
  for (const id of [lines, notes, lenderNamed]) assert.match(form, new RegExp(`<option value="${id}">`), `payable from the form: ${id}`);
  const res = await app.post('/loans/pay', { loan: String(lines), bank: String(A.checking), txn_date: TODAY, total: '500.00', principal: '500.00', interest: '', interest_account: '' });
  assert.equal(res.status, 303, await errorOf(res));
  assert.equal((await listLoans(pool, { ...S, companies: [] })).find(l => l.accountId === lines).balance, 250_000);
});

// ---- Codex review of e0d7413 ----

test('an account edit can’t break a pairing, even saved at the same moment as the pairing (review 2 #1)', async () => {
  const all = [S.entityId, B.entityId];
  const fields = (name, number, type) => ({ name, number, type, parentId: '', description: '', active: true });
  const lent = await newAccount(S, 'Loan to Second Ranch (edit)', '1490', 'other_current_asset');
  await saveLoanSetup(pool, { ...S, accountId: lent, list: '', otherAccountId: bLoan, openEntityIds: all });
  // Paired: it can't move to the other side of the books, or out of the loan types…
  for (const type of ['long_term_liability', 'bank', 'expense']) {
    await assert.rejects(saveAccount(pool, { ...S, accountId: lent, fields: fields('Loan to Second Ranch (edit)', '1490', type) }),
      /“Loan to Second Ranch \(edit\)” is paired with a loan in another company, so it stays a loan on the asset side\./);
  }
  // …but can move to another asset loan type, and be renamed.
  await saveAccount(pool, { ...S, accountId: lent, fields: fields('Loan to Second Ranch (renamed)', '1490', 'other_asset') });
  // Over HTTP the account form says why.
  const res = await app.post(`/settings/accounts/${lent}/edit`, { name: 'Loan to Second Ranch (renamed)', number: '1490', type: 'long_term_liability', parentId: '', description: '', active: '1' });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /paired with a loan in another company/);
  await saveLoanSetup(pool, { ...S, accountId: lent, list: '', otherAccountId: null, openEntityIds: all });

  // A type edit and a pairing saved at once: whichever lands second sees the first, so a pair is always receivable ↔ payable.
  for (let i = 0; i < 6; i++) {
    const x = await newAccount(S, `Loan to Second Ranch race ${i}`, `153${i}`, 'other_current_asset');
    const r = await Promise.allSettled([
      saveAccount(pool, { ...S, accountId: x, fields: fields(`Loan to Second Ranch race ${i}`, `153${i}`, 'long_term_liability') }),
      saveLoanSetup(pool, { ...S, accountId: x, list: '', otherAccountId: bLoan, openEntityIds: all })]);
    for (const y of r) if (y.status === 'rejected') assert.equal(y.reason.constructor.name, 'ValidationError', y.reason.stack);
    const { rows } = await pool.query(`SELECT a.type AS a, o.type AS o FROM account a JOIN account o ON o.account_id = a.loan_other_account_id WHERE a.org_id = $1`, [S.orgId]);
    const group = t => (['other_current_asset', 'other_asset'].includes(t) ? 'asset' : 'liability');
    for (const p of rows) assert.notEqual(group(p.a), group(p.o), `paired ${p.a} with ${p.o}`);
    await pool.query('UPDATE account SET loan_other_account_id = NULL WHERE account_id IN ($1, $2)', [x, bLoan]);
  }
});

test('the page doesn’t claim to list every loan, and says how to add one named for its lender (review 2 #2)', async () => {
  const body = await (await app.get('/loans')).text();
  assert.doesNotMatch(body, /Every loan/);
  assert.ok(body.includes('An account named for its lender rather than as a loan isn’t listed until an admin adds it'));
});
