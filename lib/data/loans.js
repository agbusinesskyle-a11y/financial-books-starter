import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { listAccounts } from './ledger.js';
import { writeVendorDoc } from './payables.js';
import { isIsoDate } from '../domain/dates.js';
import { parseMoney, formatCents } from '../domain/money.js';
import { TYPE_GROUP, LOAN_TYPES } from '../domain/ledger.js';

// The Loans page: every loan and line of credit of the company with its balance from the ledger (the chart of
// accounts' own balance) and its last payment; a loan payment split into principal and interest, booked the way QuickBooks
// books it (an expense, or a check, from the bank whose lines are the loan and the interest account); and, for a loan
// between two companies of the organization, the other company's balance next to it.

const fail = message => { throw new ValidationError(message); };
// Advisory lock key (with the organization) that takes loan pairing changes one at a time.
const PAIRING_LOCK = 74_120_061;

// Accounts that can hold a loan: what the company owes (liabilities) or has lent out (assets).
export { LOAN_TYPES };
const PAYABLE_TYPES = ['long_term_liability', 'other_current_liability'];
// Every long-term liability is a loan; the other types are when the name says so (payroll and sales tax owed, prepaid
// expenses and goodwill are not). A person can add or take off any account on the account's loan setup.
const LOAN_NAME = /\b(loans?|lines? of credit|LOCs?|notes? (payable|receivable)|N\/[PR]|due (to|from))\b/i;
const LINE_NAME = /\b(lines? of credit|LOCs?)\b/i;

export const looksLikeLoan = a => a.type === 'long_term_liability' || (LOAN_TYPES.includes(a.type) && LOAN_NAME.test(a.name));
export const isLoanAccount = a => !a.system_key && LOAN_TYPES.includes(a.type) && (a.loan_list === 'show' || (a.loan_list !== 'hide' && looksLikeLoan(a)));
export const loanKind = a => (TYPE_GROUP[a.type] === 'asset' ? 'Loan receivable' : LINE_NAME.test(a.name) ? 'Line of credit' : 'Loan');
export const isPayable = a => PAYABLE_TYPES.includes(a.type);

// companies: the companies the person may open ([{ entityId, name }]); another company's balance shows only for those.
export async function listLoans(db, { orgId, entityId, companies = [] }) {
  const accounts = await listAccounts(db, { orgId, entityId });
  const candidates = accounts.filter(isLoanAccount);
  const ids = candidates.map(a => a.account_id);
  const { rows: used } = await db.query('SELECT DISTINCT account_id FROM posting WHERE org_id = $1 AND account_id = ANY($2)', [orgId, ids]);
  const hasActivity = new Set(used.map(r => r.account_id));
  // An inactive account, or one nothing has ever posted to, stays off the list unless a person put it on.
  const loans = candidates.filter(a => a.loan_list === 'show' || (a.active && hasActivity.has(a.account_id)) || a.balance_cents !== 0);
  // The last payment: the newest transaction that brought the balance down (money paid on a loan, or paid back to the lender).
  const { rows: lastRows } = await db.query(
    `SELECT DISTINCT ON (s.account_id) s.account_id, s.txn_id, s.amount, t.type, t.txn_date, t.doc_number, t.total_cents
       FROM (SELECT account_id, txn_id, sum(amount_cents)::bigint AS amount FROM posting WHERE org_id = $1 AND entity_id = $2 AND account_id = ANY($3)
              GROUP BY account_id, txn_id) s
       JOIN txn t ON t.txn_id = s.txn_id JOIN account a ON a.account_id = s.account_id
      WHERE CASE WHEN a.type IN ('other_current_asset', 'other_asset') THEN s.amount < 0 ELSE s.amount > 0 END
      ORDER BY s.account_id, t.txn_date DESC, s.txn_id DESC`, [orgId, entityId, loans.map(a => a.account_id)]);
  const last = new Map(lastRows.map(r => [r.account_id, { txnId: r.txn_id, type: r.type, date: r.txn_date, docNumber: r.doc_number,
    principal: Math.abs(r.amount), paid: Number(r.total_cents) }]));

  // The other side of each loan (the two accounts name each other).
  const { rows: sides } = await db.query('SELECT account_id, entity_id FROM account WHERE org_id = $1 AND entity_id <> $2 AND account_id = ANY($3)',
    [orgId, entityId, loans.map(a => a.loan_other_account_id).filter(Boolean)]);
  const otherOf = new Map(loans.filter(a => a.loan_other_account_id).map(a => [a.account_id, sides.find(x => x.account_id === a.loan_other_account_id)]).filter(([, x]) => x));
  const open = new Map(companies.map(c => [Number(c.entityId), c.name]));
  const balances = new Map();
  for (const e of new Set([...otherOf.values()].map(s => s.entity_id).filter(id => open.has(id)))) {
    for (const o of await listAccounts(db, { orgId, entityId: e })) balances.set(o.account_id, o);
  }
  return loans.map(a => {
    const side = otherOf.get(a.account_id);
    let other = null;
    if (side && !open.has(side.entity_id)) other = { hidden: true };
    else if (side) {
      const o = balances.get(side.account_id);
      // The lender's receivable and the borrower's payable are both shown as a positive amount owed: they agree when equal.
      other = { entityId: side.entity_id, company: open.get(side.entity_id), accountId: o.account_id, name: o.name, number: o.number, balance: o.balance_cents,
        difference: a.balance_cents - o.balance_cents, agrees: a.balance_cents === o.balance_cents };
    }
    return { accountId: a.account_id, name: a.name, number: a.number, type: a.type, typeLabel: a.type_label, kind: loanKind(a), payable: isPayable(a),
      active: a.active, balance: a.balance_cents, listed: a.loan_list, last: last.get(a.account_id) ?? null, other };
  });
}

// What the payment form starts with for a loan: the bank, payee and amount of its last payment (an expense or a check with a
// line on the loan), and the interest account only when it's sure: the last payment's line on an account named for interest,
// else the company's one expense account named for interest; otherwise left for the person to choose.
export async function paymentDefaults(db, { orgId, entityId, loanId }) {
  const { rows: [t] } = await db.query(
    `SELECT t.vendor_id, t.account_id, t.total_cents,
            (SELECT l2.account_id FROM txn_line l2 JOIN account a2 ON a2.account_id = l2.account_id
              WHERE l2.txn_id = t.txn_id AND a2.type IN ('expense', 'other_expense') AND a2.active AND a2.name ~* 'interest' ORDER BY l2.line_no LIMIT 1) AS interest_account_id
       FROM txn t
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('expense', 'check') AND t.voided_at IS NULL
        AND EXISTS (SELECT 1 FROM txn_line l WHERE l.txn_id = t.txn_id AND l.account_id = $3)
      ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT 1`, [orgId, entityId, loanId]);
  const { rows: interest } = await db.query(
    `SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND active AND type IN ('expense', 'other_expense') AND name ~* 'interest' LIMIT 2`,
    [orgId, entityId]);
  return { vendorId: t?.vendor_id ?? null, bankId: t?.account_id ?? null, total: t ? Number(t.total_cents) : null,
    interestAccountId: t?.interest_account_id ?? (interest.length === 1 ? interest[0].account_id : null) };
}

export async function saveLoanPayment(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return writeLoanPayment(tx, args);
  });
}

// A loan payment: exactly the bank amount leaves the bank, split into principal (brings the loan down), interest (an
// expense) and any escrow or fee lines. Written as an expense from the bank, or a check when a check number is given, so it
// shows up like any other payment (vendor page, Expenses by Vendor, bank review matching). Caller holds the entity lock.
// v: { loanId, bankId, vendorId, txnDate, total, principal, interest, interestAccountId, extras: [{ accountId, amount, description }],
//      checkNo, memo } (form strings).
export async function writeLoanPayment(tx, { orgId, entityId, actor, v }) {
  if (!isIsoDate(v.txnDate)) fail('Enter a valid date.');
  const one = async (id, types) => (await tx.query('SELECT account_id, name, type FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active AND type = ANY($4)',
    [orgId, entityId, Number(id) || 0, types])).rows[0] ?? null;
  const loan = await one(v.loanId, PAYABLE_TYPES) ?? fail('Choose the loan being paid.');
  const bank = await one(v.bankId, ['bank']) ?? fail('Choose the bank account the payment came from.');
  const cents = (text, what) => {
    const s = String(text ?? '').trim();
    if (!s) return 0;
    return parseMoney(s) ?? fail(`${what}: enter an amount like 1,074.51.`);
  };
  const total = cents(v.total, 'Payment');
  if (total <= 0) fail('Enter the amount that left the bank, like 1,074.51.');
  const principal = cents(v.principal, 'Principal'), interest = cents(v.interest, 'Interest');
  const lines = [];
  if (principal > 0) lines.push({ accountId: loan.account_id, cents: principal, description: 'Principal' });
  if (interest > 0) {
    const a = await one(v.interestAccountId, ['expense', 'other_expense']) ?? fail('Choose the expense account the interest goes to.');
    lines.push({ accountId: a.account_id, cents: interest, description: 'Interest' });
  }
  for (const [i, x] of (v.extras ?? []).entries()) {
    if (!x.accountId && !String(x.amount ?? '').trim()) continue;
    const amount = cents(x.amount, `Other line ${i + 1}`);
    if (!x.accountId || amount <= 0) fail(`Other line ${i + 1}: choose the account and enter the amount (escrow, a late fee…).`);
    lines.push({ accountId: Number(x.accountId), cents: amount, description: String(x.description ?? '').trim().slice(0, 300) || null });
  }
  // The split must come to exactly what left the bank (the same rule as a split bank line).
  const sum = lines.reduce((s, l) => s + l.cents, 0);
  if (sum !== total) fail(`The split adds up to ${formatCents(sum)}; the payment is ${formatCents(total)}.`);
  const checkNo = String(v.checkNo ?? '').trim();
  const txnId = await writeVendorDoc(tx, { orgId, entityId, actor, type: checkNo ? 'check' : 'expense', vendorId: Number(v.vendorId) || null, txnDate: v.txnDate,
    accountId: bank.account_id, docNumber: checkNo, memo: v.memo, itemLines: [],
    categoryLines: lines.map(l => ({ accountId: l.accountId, amount: (l.cents / 100).toFixed(2), description: l.description })) });
  // Whatever was written must move the bank by the payment and the loan by the principal.
  const { rows: [m] } = await tx.query(
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE account_id = $2), 0)::bigint AS bank, coalesce(sum(amount_cents) FILTER (WHERE account_id = $3), 0)::bigint AS loan
       FROM posting WHERE txn_id = $1`, [txnId, bank.account_id, loan.account_id]);
  if (Number(m.bank) !== -total || Number(m.loan) !== principal) throw new Error(`loan payment posted bank ${m.bank}, loan ${m.loan}; expected ${-total}, ${principal}`);
  return txnId;
}

// The loan setup of one account: whether the Loans page lists it ('' = by its type and name, 'show', 'hide'), and the same loan
// in another company's books (openEntityIds: the companies the person may open). The two accounts name each other (migration
// 063). Pairing changes are taken one at a time for the whole organization, then every company they touch is locked in
// order, and only then are the accounts read and checked — so two saves at once can't leave A paired with B while B names
// C, and an account edit can't change a type under the check. (Account edits keep a pairing valid: lib/data/ledger.js.)
export async function saveLoanSetup(pool, { orgId, entityId, accountId, list, otherAccountId, openEntityIds }) {
  if (!['', 'show', 'hide'].includes(list ?? '')) fail('Choose whether the Loans page lists this account.');
  const otherId = otherAccountId ? Number(otherAccountId) : null;
  return withTransaction(pool, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [PAIRING_LOCK, Number(orgId)]);
    const load = async id => (await tx.query(`SELECT a.account_id, a.entity_id, a.name, a.type, a.active, a.system_key, a.loan_other_account_id, e.name AS company
                                                FROM account a JOIN entity e ON e.entity_id = a.entity_id WHERE a.org_id = $1 AND a.account_id = $2`, [orgId, id])).rows[0] ?? null;
    // Which companies the change touches: this account's, the chosen account's and its present partner's (an account's
    // company never changes, and its partner only under the pairing lock held here). Those are locked first, in order, and
    // only then is anything checked, so an account edit (which takes its company's lock) can't slip in between.
    const { rows: touched } = await tx.query(
      `SELECT DISTINCT x.entity_id FROM account a JOIN account x ON x.org_id = a.org_id AND x.account_id IN (a.account_id, a.loan_other_account_id, $3)
        WHERE a.org_id = $1 AND a.account_id = $2 ORDER BY x.entity_id`, [orgId, accountId, otherId]);
    for (const { entity_id: e } of touched) await lockEntity(tx, orgId, e);
    const a = await load(accountId);
    if (!a || a.entity_id !== Number(entityId)) fail('Account not found.');
    if (a.system_key || !LOAN_TYPES.includes(a.type)) fail('Only liability and asset accounts (not bank, card, A/R or A/P) can be loans.');
    const o = otherId ? await load(otherId) : null;
    if (otherId && (!o || o.entity_id === Number(entityId) || !openEntityIds.includes(o.entity_id))) fail('Choose an account in another of your companies.');
    // This account's present partner (unpaired when the choice changes) and the chosen account's (which must be this one or none).
    const was = a.loan_other_account_id ? await load(a.loan_other_account_id) : null;
    const theirs = o?.loan_other_account_id ? await load(o.loan_other_account_id) : null;
    if (o) {
      if (!o.active || o.system_key || !LOAN_TYPES.includes(o.type)) fail(`“${o.name}” can’t hold a loan. Choose a liability or asset account.`);
      if (TYPE_GROUP[o.type] === TYPE_GROUP[a.type]) {
        fail(`The other side of a loan is on the other side of the books: ${TYPE_GROUP[a.type] === 'asset' ? 'a liability (what the borrower owes)' : 'an asset (what the lender is owed)'}.`);
      }
      // Already paired with another loan: named only when the person may open that company.
      if (theirs && theirs.account_id !== a.account_id) {
        fail(openEntityIds.includes(theirs.entity_id) ? `“${o.name}” in ${o.company} is already the other side of “${theirs.name}” in ${theirs.company}. Change that one first.`
          : `“${o.name}” in ${o.company} is already paired with an account in another company. Change that one first.`);
      }
    }
    if (was && was.account_id !== otherId) {
      // Unpairing (or pairing with another account) also clears the old partner's side, in a company the person may open.
      if (!openEntityIds.includes(was.entity_id)) fail('This loan is paired with an account in a company you can’t open. Ask someone who can open both to change it.');
      await tx.query('UPDATE account SET loan_other_account_id = NULL WHERE org_id = $1 AND account_id = $2', [orgId, was.account_id]);
    }
    await tx.query('UPDATE account SET loan_list = $3, loan_other_account_id = $4 WHERE org_id = $1 AND account_id = $2', [orgId, a.account_id, list || null, o?.account_id ?? null]);
    if (o) await tx.query('UPDATE account SET loan_other_account_id = $3 WHERE org_id = $1 AND account_id = $2', [orgId, o.account_id, a.account_id]);
  });
}

// The choices for the other side of a loan: the opposite-side loan-type accounts of every other company the person may open.
export async function otherSideChoices(db, { orgId, entityId, accountType, openEntityIds }) {
  const wanted = LOAN_TYPES.filter(t => TYPE_GROUP[t] !== TYPE_GROUP[accountType]);
  const { rows } = await db.query(
    `SELECT a.account_id, a.name, a.number, e.entity_id, e.name AS company FROM account a JOIN entity e ON e.entity_id = a.entity_id
      WHERE a.org_id = $1 AND a.entity_id <> $2 AND a.entity_id = ANY($3) AND a.active AND a.system_key IS NULL AND a.type = ANY($4)
      ORDER BY lower(e.name), a.number NULLS LAST, lower(a.name)`, [orgId, entityId, openEntityIds, wanted]);
  return rows;
}

// One account's loan setup as the form shows it: the account, whether it's listed, and its other side.
export async function getLoanSetup(db, { orgId, entityId, accountId }) {
  const { rows: [a] } = await db.query(
    `SELECT a.account_id, a.name, a.number, a.type, a.active, a.system_key, a.loan_list,
            a.loan_other_account_id AS other_account_id
       FROM account a WHERE a.org_id = $1 AND a.entity_id = $2 AND a.account_id = $3 AND a.type = ANY($4) AND a.system_key IS NULL`, [orgId, entityId, accountId, LOAN_TYPES]);
  return a ? { ...a, listed: isLoanAccount(a), byRule: looksLikeLoan(a) } : null;
}

// Accounts that could hold a loan but aren't on the page (shownIds: the accounts it lists), to put one on it.
export async function unlistedLoanAccounts(db, { orgId, entityId, shownIds }) {
  const shown = new Set(shownIds);
  return (await listAccounts(db, { orgId, entityId, includeInactive: false })).filter(a => !a.system_key && LOAN_TYPES.includes(a.type) && !shown.has(a.account_id));
}
