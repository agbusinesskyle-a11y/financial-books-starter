// test/tax-ownership.test.js — owners and members (ownership_interest): roles by return, exact shares with unknown never zero, history
// kept, the period roster, and the owner references bindings resolve to them. Sample names only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, party } from './tax-t2-fixtures.js';
import { saveInterest, endInterest, listInterests, rosterFor } from '../lib/tax/ownership.js';
import { saveBindings, listBindings, resolveReferences, T2_RESOLVERS } from '../lib/tax/bindings.js';
import { openPeriod, saveProfile } from '../lib/tax/periods.js';
import { saveParty } from '../lib/tax/parties.js';

let t, pool, orgId, P, ret, ann, ben, trust;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  P = { orgId, entityId: await company(pool, orgId, 'Olive Partners') };
  ret = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  ann = await party(pool, orgId, 'Ann Sample Partner'); ben = await party(pool, orgId, 'Ben Sample Partner'); trust = await party(pool, orgId, 'Sample Family Trust', 'trust');
});
after(async () => { await t.db.drop(); });
const save = fields => saveInterest(pool, { ...P, fields, actor: 'tester' });

test('roles follow the return; shares are exact, a blank share is unknown (never zero), and stated shares never total more than 1', async () => {
  await assert.rejects(save({ partyId: ann, role: 'shareholder', from: '2025-01-01', profit: '1/2' }), /general partner|limited partner/);
  await save({ partyId: ann, role: 'general_partner', from: '2025-01-01', profit: '1/2', loss: '50%', capital: '' });
  await assert.rejects(save({ partyId: ben, role: 'limited_partner', from: '2025-01-01', profit: '2/3' }), /total 7\/6, more than 1/);
  await save({ partyId: ben, role: 'limited_partner', from: '2025-01-01', profit: '1/2', loss: '1/2', capital: '' });
  const r = await rosterFor(pool, { ...P, periodStart: '2025-01-01', periodEnd: '2025-12-31' });
  assert.equal(r.status, 'incomplete');
  assert.match(r.problems.join(' '), /capital shares are not known yet/);
  const [a] = (await listInterests(pool, P)).filter(x => x.party_id === ann);
  assert.deepEqual([a.profit_num, a.profit_den, a.loss_num, a.loss_den, a.capital_num], ['1', '2', '1', '2', null]);
  await assert.rejects(save({ partyId: ann, role: 'general_partner', from: '2025-01-01', profit: '0.5' }), /fraction like 1\/3/);
  // A shareholder is a person or a trust (the database refuses it too).
  await assert.rejects(pool.query(`INSERT INTO ownership_interest (org_id, entity_id, party_id, role, effective_from, created_by) VALUES ($1,$2,$3,'shareholder','2025-01-01','t')`,
    [orgId, P.entityId, await party(pool, orgId, 'Outside Sample LLC', 'entity_outside')]), /shareholder is a person or a trust/);
});

test('history is kept: a later change closes the earlier interest the day before; a change re-saved on its own date corrects it; ending keeps the row', async () => {
  await save({ partyId: ann, role: 'general_partner', from: '2025-01-01', profit: '1/2', loss: '1/2', capital: '1/2' });
  await save({ partyId: ben, role: 'limited_partner', from: '2025-01-01', profit: '1/2', loss: '1/2', capital: '1/2' });
  assert.equal((await rosterFor(pool, { ...P, periodStart: '2025-01-01', periodEnd: '2025-12-31' })).status, 'complete');
  // 2026: Ann's share changes; the 2025 row stays as history.
  await save({ partyId: ann, role: 'general_partner', from: '2026-01-01', profit: '1/3', loss: '1/3', capital: '1/3' });
  const anns = (await listInterests(pool, P)).filter(x => x.party_id === ann);
  assert.deepEqual(anns.map(x => [x.effective_from, x.effective_to, x.profit_num]), [['2026-01-01', null, '1'], ['2025-01-01', '2025-12-31', '1']]);
  await assert.rejects(save({ partyId: ann, role: 'general_partner', from: '2025-06-01', profit: '1/2' }), /later change/);
  // The 2026 shares total 5/6 for profit: not complete. A trust joins with 1/6.
  assert.match((await rosterFor(pool, { ...P, periodStart: '2026-01-01', periodEnd: '2026-12-31' })).problems.join(' '), /profit shares total 5\/6/);
  await save({ partyId: trust, role: 'limited_partner', from: '2026-01-01', profit: '1/6', loss: '1/6', capital: '1/6' });
  assert.equal((await rosterFor(pool, { ...P, periodStart: '2026-01-01', periodEnd: '2026-12-31' })).status, 'complete');
  // Ending the trust's interest mid-2026: the owners change inside the period (allocation across a change is T4's).
  const tr = (await listInterests(pool, P)).find(x => x.party_id === trust);
  await endInterest(pool, { ...P, interestId: tr.interest_id, to: '2026-06-30' });
  assert.match((await rosterFor(pool, { ...P, periodStart: '2026-01-01', periodEnd: '2026-12-31' })).problems.join(' '), /change during the period/);
  assert.equal((await listInterests(pool, P)).find(x => x.party_id === trust).effective_to, '2026-06-30', 'kept, not deleted');
});

test('a binding’s owner reference resolves to the owner’s interest for the period, and copy-forward re-resolves it for the next period', async () => {
  const draws = await acct(pool, P, 'Owner’s Draw');
  await je(pool, P, '2025-05-01', [[draws, 4000], [await acct(pool, P, 'Checking'), -4000]]);
  await saveBindings(pool, { ...P, returnId: ret, sourceEntityId: P.entityId, accountId: draws, measurement: 'activity', makeDefault: true,
    rows: [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: ann }], actor: 'tester' });
  const ann25 = (await listInterests(pool, P)).find(x => x.party_id === ann && x.effective_from === '2025-01-01').interest_id;
  const [b25] = (await listBindings(pool, { ...P, returnId: ret })).filter(b => b.account_id === draws);
  assert.deepEqual([b25.interest_id, b25.pending], [ann25, []]);
  const r26 = Number(await openPeriod(pool, { ...P, year: 2026, actor: 'tester' }));
  const ann26 = (await listInterests(pool, P)).find(x => x.party_id === ann && x.effective_from === '2026-01-01').interest_id;
  const [b26] = (await listBindings(pool, { ...P, returnId: r26 })).filter(b => b.account_id === draws);
  assert.equal(b26.interest_id, ann26, 'the default reused for 2026 selects 2026’s interest');
  // A correction of that interest is a new version: the binding is refreshed.
  await save({ partyId: ann, role: 'general_partner', from: '2026-01-01', profit: '1/3', loss: '1/3', capital: '1/4' });
  assert.equal((await resolveReferences(pool, { ...P, returnId: r26 })).updated, 1);
  // A household return has no owners.
  const H = { orgId, entityId: await company(pool, orgId, 'Sample Household') };
  await saveProfile(pool, { ...H, fields: { returnType: 'household_1040', taxMethodDefault: 'cash', bookBasisDefault: 'cash', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  await assert.rejects(saveInterest(pool, { ...H, fields: { partyId: ann, role: 'general_partner', from: '2025-01-01' }, actor: 'tester' }), /household return has no owners/);
});

test('the whole history stays valid (Codex r5 R5-N1): saves in reverse order, an end moved across a successor, a period opened under other defaults', async () => {
  const Q = { orgId, entityId: await company(pool, orgId, 'Quince Partners') };
  await period(pool, Q, 2025, 'form_1065', { taxMethod: 'accrual' });
  const s = fields => saveInterest(pool, { ...Q, fields, actor: 'tester' });
  const a = await party(pool, orgId, 'Ari Sample Partner'), b = await party(pool, orgId, 'Bo Sample Partner'), c = await party(pool, orgId, 'Cy Sample Partner');
  // A from 2025 at 1/2, B from 2026 at 1/2, then C from 2025 at 1/2: from 2026 the shares would total 3/2 — refused whatever the order.
  await s({ partyId: a, role: 'general_partner', from: '2025-01-01', profit: '1/2' });
  await s({ partyId: b, role: 'limited_partner', from: '2026-01-01', profit: '1/2' });
  await assert.rejects(s({ partyId: c, role: 'limited_partner', from: '2025-01-01', profit: '1/2' }), /in effect on 2026-01-01 would total 3\/2/);
  // A's own successor from 2027; moving the 2025 row's end across it is refused (two interests of one owner on the same days).
  await s({ partyId: a, role: 'general_partner', from: '2027-01-01', profit: '1/4' });
  const first = (await listInterests(pool, Q)).find(x => x.party_id === a && x.effective_from === '2025-01-01');
  assert.equal(first.effective_to, '2026-12-31');
  await assert.rejects(endInterest(pool, { ...Q, interestId: first.interest_id, to: '2027-12-31' }), /two interests on the same days/);
  // Two single members of a disregarded company, entered in reverse date order, are refused.
  const D = { orgId, entityId: await company(pool, orgId, 'Quince Single LLC') };
  await period(pool, D, 2025, 'disregarded');
  await saveInterest(pool, { ...D, fields: { partyId: a, role: 'single_member', from: '2025-06-01' }, actor: 'tester' });
  await assert.rejects(saveInterest(pool, { ...D, fields: { partyId: b, role: 'single_member', from: '2025-01-01' }, actor: 'tester' }), /one owner at a time/);
  // The defaults change to an S corporation: opening 2028 is refused while partners' interests run into it (the period's own facts);
  // correcting a partner's row in the 2026 partnership year stays possible.
  await openPeriod(pool, { ...Q, year: 2026, actor: 'tester' });
  await saveProfile(pool, { ...Q, fields: { returnType: 'form_1120s', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'S election', actor: 'tester' });
  await assert.rejects(openPeriod(pool, { ...Q, year: 2028, actor: 'tester' }), /files form_1120s, which takes no (general|limited)_partner interest/);
  await s({ partyId: b, role: 'limited_partner', from: '2026-01-01', profit: '1/2', loss: '1/2' });
  // The roster says what is wrong too, independently: a role the period's return does not take.
  const r = await rosterFor(pool, { ...Q, periodStart: '2025-01-01', periodEnd: '2025-12-31', returnType: 'form_1120s' });
  assert.match(r.problems.join(' '), /role this period’s return does not take/);
});

test('an interest’s version covers every fact, unknown shares in their places (Codex r5 R5-N2), and a binding names only its own owner’s interest in its return’s company (R5-N3)', async () => {
  const W = { orgId, entityId: await company(pool, orgId, 'Walnut Partners') };
  const wRet = await period(pool, W, 2025, 'form_1065', { taxMethod: 'accrual' });
  const x = await party(pool, orgId, 'Xan Sample Partner'), y = await party(pool, orgId, 'Yul Sample Partner');
  await saveInterest(pool, { ...W, fields: { partyId: x, role: 'general_partner', from: '2025-01-01', profit: '1/2', loss: '', capital: '1/2' }, actor: 'tester' });
  await saveInterest(pool, { ...W, fields: { partyId: y, role: 'limited_partner', from: '2025-01-01', profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' });
  const draws = await acct(pool, W, 'Owner’s Draw');
  await je(pool, W, '2025-05-01', [[draws, 1000], [await acct(pool, W, 'Checking'), -1000]]);
  await saveBindings(pool, { ...W, returnId: wRet, sourceEntityId: W.entityId, accountId: draws, measurement: 'activity', rows: [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: x }], actor: 'tester' });
  const [b] = (await listBindings(pool, { ...W, returnId: wRet })).filter(z => z.account_id === draws);
  // Profit known → unknown, loss unknown → known: the same values in other places — a new version, the binding refreshed.
  await saveInterest(pool, { ...W, fields: { partyId: x, role: 'general_partner', from: '2025-01-01', profit: '', loss: '1/2', capital: '1/2' }, actor: 'tester' });
  assert.equal((await resolveReferences(pool, { ...W, returnId: wRet, resolvers: T2_RESOLVERS })).updated, 1);
  assert.notEqual((await listBindings(pool, { ...W, returnId: wRet })).find(z => z.binding_id === b.binding_id).interest_version, b.interest_version);
  // The database refuses an interest of another owner, or of another company, on that binding; and an interest keeps its owner.
  const yInt = (await listInterests(pool, W)).find(z => z.party_id === y).interest_id;
  await assert.rejects(pool.query('UPDATE tax_binding SET interest_id = $2 WHERE binding_id = $1', [b.binding_id, yInt]), /not this owner's interest in the return's company/);
  const other = (await listInterests(pool, P)).find(z => z.party_id === ann).interest_id;
  await assert.rejects(pool.query('UPDATE tax_binding SET interest_id = $2 WHERE binding_id = $1', [b.binding_id, other]), /not this owner's interest in the return's company/);
  await assert.rejects(pool.query('UPDATE ownership_interest SET party_id = $2 WHERE interest_id = $1', [yInt, x]), /keeps its company and its owner/);
});

test('a historical correction is judged by its own period, not today’s defaults (Codex r6 R6-N2)', async () => {
  const H = { orgId, entityId: await company(pool, orgId, 'Hawthorn Partners') };
  await period(pool, H, 2025, 'form_1065', { taxMethod: 'accrual' });
  const p = await party(pool, orgId, 'Hal Sample Partner');
  await saveInterest(pool, { ...H, fields: { partyId: p, role: 'general_partner', from: '2025-01-01', to: '2025-12-31', profit: '100%', loss: '100%', capital: '' }, actor: 'tester' });
  await saveProfile(pool, { ...H, fields: { returnType: 'household_1040', taxMethodDefault: 'cash', bookBasisDefault: 'cash', yearEndMonth: 12 }, reason: 'now a household', actor: 'tester' });
  await saveInterest(pool, { ...H, fields: { partyId: p, role: 'general_partner', from: '2025-01-01', to: '2025-12-31', profit: '100%', loss: '100%', capital: '100%' }, actor: 'tester' });
  assert.equal((await listInterests(pool, H))[0].capital_num, '1');
  // An interest outside every period follows the defaults: a household takes no owners.
  await assert.rejects(saveInterest(pool, { ...H, fields: { partyId: p, role: 'general_partner', from: '2026-01-01', profit: '100%' }, actor: 'tester' }), /household return has no owners/);
});

test('competing roster and period writes of one company serialize in the database (Codex r6 R6-N1): the second waits, then refuses', async () => {
  const waiting = pr => Promise.race([pr.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('waiting'), 300))]);
  const ins = (c, row) => c.query(`INSERT INTO ownership_interest (org_id, entity_id, party_id, role, effective_from, profit_num, profit_den, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'t')`,
    [orgId, row.entityId, row.partyId, row.role, row.from, row.num ?? null, row.den ?? null]);
  const race = async (first, second, expect) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await first(c);
      const late = second();
      assert.equal(await waiting(late), 'waiting');
      await c.query('COMMIT');
      await assert.rejects(late, expect);
    } finally { c.release(); }
  };
  const a = await party(pool, orgId, 'Ada Race Partner'), b = await party(pool, orgId, 'Bea Race Partner');
  // Two single members of one disregarded company, written at once.
  const D = { orgId, entityId: await company(pool, orgId, 'Race Single LLC') };
  await period(pool, D, 2025, 'disregarded');
  await race(c => ins(c, { entityId: D.entityId, partyId: a, role: 'single_member', from: '2025-01-01' }), () => ins(pool, { entityId: D.entityId, partyId: b, role: 'single_member', from: '2025-02-01' }), /one owner at a time/);
  // Two partners whose profit shares would total 4/3.
  const P2 = { orgId, entityId: await company(pool, orgId, 'Race Partners') };
  await period(pool, P2, 2025, 'form_1065');
  await race(c => ins(c, { entityId: P2.entityId, partyId: a, role: 'general_partner', from: '2025-01-01', num: 2, den: 3 }),
    () => ins(pool, { entityId: P2.entityId, partyId: b, role: 'limited_partner', from: '2025-01-01', num: 2, den: 3 }), /would total 4\/3/);
  // A period's return type changed while a partner's interest is being written.
  const P3 = { orgId, entityId: await company(pool, orgId, 'Race Change Partners') };
  const r3 = await period(pool, P3, 2025, 'form_1065');
  await race(c => ins(c, { entityId: P3.entityId, partyId: a, role: 'general_partner', from: '2025-01-01' }),
    () => pool.query(`UPDATE tax_return SET return_type = 'form_1120s' WHERE org_id = $1 AND return_id = $2`, [orgId, r3]), /takes no general_partner interest/);
});

test('a REPEATABLE READ or SERIALIZABLE snapshot cannot write the roster or a period’s type and dates (Codex r7 R7-N1): it would check a stale roster', async () => {
  const waiting = pr => Promise.race([pr.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('waiting'), 300))]);
  const ins = (c, entityId, partyId, from) => c.query(`INSERT INTO ownership_interest (org_id, entity_id, party_id, role, effective_from, created_by) VALUES ($1,$2,$3,'single_member',$4,'t')`,
    [orgId, entityId, partyId, from]);
  const members = async entityId => (await pool.query('SELECT party_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows.length;
  const a = await party(pool, orgId, 'Ada Snapshot Member'), b = await party(pool, orgId, 'Bo Snapshot Member');
  const A = await pool.connect(), B = await pool.connect();
  let last;
  try {
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      // The review's case: a disregarded 2025 period with no owners; A and B begin at this level and B's snapshot is established by
      // reading the empty roster. A snapshot writer is refused outright…
      const D = { orgId, entityId: await company(pool, orgId, `Snapshot ${level} LLC`) };
      await period(pool, D, 2025, 'disregarded');
      await A.query(`BEGIN ISOLATION LEVEL ${level}`); await B.query(`BEGIN ISOLATION LEVEL ${level}`);
      assert.equal((await B.query('SELECT count(*)::int AS n FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [orgId, D.entityId])).rows[0].n, 0);
      await assert.rejects(ins(A, D.entityId, a, '2025-01-01'), new RegExp(`READ COMMITTED transaction; a ${level} snapshot`));
      await A.query('ROLLBACK');
      // …and with A writing Ann in READ COMMITTED and holding the company, B's Bo waits, then is refused when A commits — never two
      // single members committed from a stale snapshot.
      await A.query('BEGIN');
      await ins(A, D.entityId, a, '2025-01-01');
      const late = ins(B, D.entityId, b, '2025-02-01');
      assert.equal(await waiting(late), 'waiting');
      await A.query('COMMIT');
      await assert.rejects(late, /change owners and return periods in a READ COMMITTED transaction/);
      await B.query('ROLLBACK');
      assert.equal(await members(D.entityId), 1, `${level}: only Ann`);
      await pool.query('SELECT tax_check_roster($1, $2)', [orgId, D.entityId]);
      last = D;
    }
    // A period's return type and dates are roster writes too; a period write that changes neither is not.
    const r = (await pool.query('SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2', [orgId, last.entityId])).rows[0].return_id;
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
      for (const change of [`return_type = 'form_1065'`, `period_start = DATE '2025-03-01', initial_status = 'requested'`]) {
        await B.query(`BEGIN ISOLATION LEVEL ${level}`);
        await assert.rejects(B.query(`UPDATE tax_return SET ${change} WHERE org_id = $1 AND return_id = $2`, [orgId, r]), /change owners and return periods in a READ COMMITTED transaction/, `${level} ${change}`);
        await B.query('ROLLBACK');
      }
      await B.query(`BEGIN ISOLATION LEVEL ${level}`);
      await B.query('UPDATE tax_return SET return_type = return_type WHERE org_id = $1 AND return_id = $2', [orgId, r]);
      await B.query('ROLLBACK');
    }
  } finally { A.release(); B.release(); }
});

// A pool whose transactions pause just before COMMIT until released (the review's adapter for t2-r1 B5).
function heldPool() {
  let reached, release;
  const atCommit = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
  const held = { async connect() { const c = await pool.connect(); return { query: async (sql, params) => { if (sql === 'COMMIT') { reached(); await gate; } return c.query(sql, params); }, release: () => c.release() }; } };
  return { held, atCommit, release };
}
const waitingOn = pr => Promise.race([pr.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('waiting'), 300))]);
const resolverFor = (entityId, partyId) => T2_RESOLVERS.interest({ db: pool, orgId, issuerEntityId: entityId, partyId, periodStart: '2025-01-01', periodEnd: '2025-12-31' });

test('party edits cannot invalidate ownership (Codex t2-r1 B5): no company becomes its own owner, a shareholder stays a person or a trust, a current owner stays active', async () => {
  // 1. The review's first case: a disregarded company's single member re-pointed at the company itself.
  const D = { orgId, entityId: await company(pool, orgId, 'Sample Self LLC') };
  await period(pool, D, 2025, 'disregarded');
  const member = await party(pool, orgId, 'Sample Self Member');
  await saveInterest(pool, { ...D, fields: { partyId: member, role: 'single_member', from: '2025-01-01', profit: '100%', loss: '100%', capital: '100%' }, actor: 'tester' });
  const before = await resolverFor(D.entityId, member);
  await assert.rejects(saveParty(pool, { orgId, partyId: member, fields: { kind: 'entity_in_org', entityId: D.entityId, name: 'Sample Self LLC Party', taxId: '' }, env: {} }), /not its own owner/);
  await assert.rejects(pool.query(`UPDATE tax_party SET kind = 'entity_in_org', entity_id = $3 WHERE org_id = $1 AND party_id = $2`, [orgId, member, D.entityId]), /not its own owner/);
  assert.deepEqual(await resolverFor(D.entityId, member), before);
  // Linked to ANOTHER company it may be (that company owns this one); the interest's version follows the owner's identity.
  const other = await company(pool, orgId, 'Sample Holding Co');
  await saveParty(pool, { orgId, partyId: member, fields: { kind: 'entity_in_org', entityId: other, name: 'Sample Holding Co Party', taxId: '' }, env: {} });
  const relinked = await resolverFor(D.entityId, member);
  assert.equal(relinked.status, 'selected');
  assert.notEqual(relinked.version, before.version, 'a changed owner identity is a new interest version');
  // 2. A shareholder stays a person or a trust, through the module and the database.
  const S = { orgId, entityId: await company(pool, orgId, 'Sample Kind Corp') };
  await period(pool, S, 2025, 'form_1120s');
  const holder = await party(pool, orgId, 'Sample Kind Shareholder');
  await saveInterest(pool, { ...S, fields: { partyId: holder, role: 'shareholder', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  await assert.rejects(saveParty(pool, { orgId, partyId: holder, fields: { kind: 'entity_outside', name: 'Sample Kind Holdings', taxId: '' }, env: {} }), /stays a person or a trust/);
  // 3. A current owner is not deactivated; once the interest has ended, the party may be.
  await assert.rejects(saveParty(pool, { orgId, partyId: holder, fields: { kind: 'individual', name: 'Sample Kind Shareholder', taxId: '', active: false }, env: {} }), /current owner/);
  await assert.rejects(pool.query('UPDATE tax_party SET active = false WHERE org_id = $1 AND party_id = $2', [orgId, holder]), /current owner/);
  const [i] = await listInterests(pool, S);
  await endInterest(pool, { ...S, interestId: i.interest_id, to: '2025-12-31' });
  await saveParty(pool, { orgId, partyId: holder, fields: { kind: 'individual', name: 'Sample Kind Shareholder', taxId: '', active: false }, env: {} });
  // 4. Independently of the guards, the roster and the resolver refuse an invalid identity (the guards switched off for the test only).
  const X = { orgId, entityId: await company(pool, orgId, 'Sample Forced Corp') };
  await period(pool, X, 2025, 'form_1120s');
  const forced = await party(pool, orgId, 'Sample Forced Holder');
  await saveInterest(pool, { ...X, fields: { partyId: forced, role: 'shareholder', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  await pool.query('ALTER TABLE tax_party DISABLE TRIGGER tax_party_owner_facts');
  try { await pool.query(`UPDATE tax_party SET kind = 'entity_in_org', entity_id = $3 WHERE org_id = $1 AND party_id = $2`, [orgId, forced, X.entityId]); }
  finally { await pool.query('ALTER TABLE tax_party ENABLE TRIGGER tax_party_owner_facts'); }
  const roster = await rosterFor(pool, { ...X, periodStart: '2025-01-01', periodEnd: '2025-12-31', returnType: 'form_1120s' });
  assert.equal(roster.status, 'incomplete');
  assert.match(roster.problems.join(' '), /its own owner/);
  assert.match(roster.problems.join(' '), /person or a trust/);
  assert.equal((await resolverFor(X.entityId, forced)).status, 'ineligible');
});

test('a party edit and an interest write serialize on the party (Codex t2-r1 B5): whichever commits first, the other rereads it and is refused', async () => {
  // The review's second case: a party edit to an outside company held just before COMMIT; a shareholder interest for it waits, then refuses.
  const S = { orgId, entityId: await company(pool, orgId, 'Sample Race Corp') };
  await period(pool, S, 2025, 'form_1120s');
  const sp = await party(pool, orgId, 'Sample Race Shareholder');
  const h = heldPool();
  const edit = saveParty(h.held, { orgId, partyId: sp, fields: { kind: 'entity_outside', name: 'Sample Corporate Shareholder', taxId: '' }, env: {} });
  await h.atCommit;
  const add = saveInterest(pool, { ...S, fields: { partyId: sp, role: 'shareholder', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  assert.equal(await waitingOn(add), 'waiting');
  h.release();
  await edit;
  await assert.rejects(add, /person or a trust/);
  assert.equal((await listInterests(pool, S)).length, 0);
  // The other order: the interest held before COMMIT; the party edit waits, then refuses.
  const S2 = { orgId, entityId: await company(pool, orgId, 'Sample Race Two Corp') };
  await period(pool, S2, 2025, 'form_1120s');
  const sp2 = await party(pool, orgId, 'Sample Race Two Shareholder');
  const h2 = heldPool();
  const add2 = saveInterest(h2.held, { ...S2, fields: { partyId: sp2, role: 'shareholder', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  await h2.atCommit;
  const edit2 = saveParty(pool, { orgId, partyId: sp2, fields: { kind: 'entity_outside', name: 'Sample Corporate Two', taxId: '' }, env: {} });
  assert.equal(await waitingOn(edit2), 'waiting');
  h2.release();
  await add2;
  await assert.rejects(edit2, /stays a person or a trust/);
  assert.equal((await rosterFor(pool, { ...S2, periodStart: '2025-01-01', periodEnd: '2025-12-31', returnType: 'form_1120s' })).status, 'complete');
  // A snapshot transaction cannot change an owner's identity facts (it could not see an interest committed while it waited).
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(c.query(`UPDATE tax_party SET name = 'Renamed' , kind = 'trust' WHERE org_id = $1 AND party_id = $2`, [orgId, sp2]), /READ COMMITTED/);
    await c.query('ROLLBACK');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query(`UPDATE tax_party SET name = 'Sample Race Two Renamed' WHERE org_id = $1 AND party_id = $2`, [orgId, sp2]);
    await c.query('ROLLBACK');
  } finally { c.release(); }
});
