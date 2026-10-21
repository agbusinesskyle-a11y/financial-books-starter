import { withTransaction } from '../db.js';
import { ensureSystemAccounts, repostMany, ledgerCheck } from '../data/ledger.js';
import { postingsFor, SYSTEM_ACCOUNTS } from '../domain/ledger.js';
import { openItems as reportOpenItems } from '../reports/receivables.js';

// Stage B7: one company's books from a QuickBooks Online export (see qbo-read.js) into a new, empty
// company: QuickBooks' chart of accounts, customers and vendors, and every transaction in the Journal, all dates.
//
// Each QuickBooks transaction becomes the same kind of transaction here — check, expense, deposit, transfer, credit card
// payment, invoice, credit memo, sales receipt, payment, bill, vendor credit, bill payment — built the way this app builds
// them. Before it is saved, its postings are worked out by the app's own posting rules and compared with QuickBooks'
// Journal lines for it; if they differ in any way (or the shape doesn't fit) it is saved as a journal entry with exactly
// QuickBooks' lines instead. txn.source_type keeps QuickBooks' own name for each one.
//
// After the independent review (2026-10-13):
//  • Imported history is locked (migration 049): it can be paid, scheduled and printed, never edited, voided or deleted.
//  • A sale's cost of goods is a journal entry tied to the sale (txn.companion_of_txn_id).
//  • Which payment or credit paid which invoice or bill isn't in QuickBooks' exports. Open amounts come from its A/R and
//    A/P Aging Detail reports; the links are rebuilt oldest-first so exactly those amounts stay open, and are marked as
//    rebuilt (application.source). Customer and vendor balances, aging, statements and Receive payment then agree.
//  • Nothing is dropped silently: transactions with no amounts are listed in the import's omissions, and lines with
//    no amount keep their words in the transaction's memo.
//  • Every account is checked against QuickBooks' Trial Balance before anything is saved; a mismatch stops the import
//    unless that account's difference is accepted by name (acceptMismatches).

const QBO_TYPES = {
  'Bank': 'bank', 'Accounts receivable (A/R)': 'accounts_receivable', 'Other Current Assets': 'other_current_asset', 'Fixed Assets': 'fixed_asset',
  'Other Assets': 'other_asset', 'Accounts payable (A/P)': 'accounts_payable', 'Credit Card': 'credit_card', 'Other Current Liabilities': 'other_current_liability',
  'Long Term Liabilities': 'long_term_liability', 'Equity': 'equity', 'Income': 'income', 'Other Income': 'other_income',
  'Cost of Goods Sold': 'cost_of_goods_sold', 'Expenses': 'expense', 'Other Expense': 'other_expense',
};
// QuickBooks' special accounts are this app's system accounts.
function systemKeyOf(a) {
  if (a.parent) return null;
  if (a.type === 'Accounts receivable (A/R)') return 'ar';
  if (a.type === 'Accounts payable (A/P)') return 'ap';
  if (a.detail === 'Undeposited Funds') return 'undeposited';
  if (a.detail === 'Inventory' && a.name === 'Inventory Asset') return 'inventory';
  if (a.detail === 'Retained Earnings') return 'retained';
  if (a.detail === 'Opening Balance Equity') return 'opening_equity';
  if (a.type === 'Cost of Goods Sold' && a.name === 'Cost of Goods Sold') return 'cogs';
  return null;
}
const ourType = a => (a.detail === 'Inventory' && a.name === 'Inventory Asset' ? 'inventory' : QBO_TYPES[a.type]);

const MONEY_TYPES = new Set(['bank', 'credit_card']);
const CHARGE_TYPES = { ar: ['invoice'], ap: ['bill'] };
const CREDIT_TYPES = { ar: ['payment', 'credit_memo'], ap: ['bill_payment', 'vendor_credit'] };

export class ImportError extends Error {}

// data: readQboExport() result. Returns { entityId, summary, ... }.
export async function importQboCompany(pool, { orgId, companyName, timeZone = 'America/Chicago', data, actor, acceptMismatches = [] }) {
  return withTransaction(pool, async tx => {
    if ((data.txns ?? []).some(t => t.currency || t.exchangeRate || t.foreignTotal) || [...(data.customers ?? []), ...(data.vendors ?? [])].some(c => c.currency)) {
      throw new ImportError('This company uses more than one currency; importing foreign-currency QuickBooks books isn’t supported yet.');
    }
    // The importer builds the locked history itself (migration 049), inside this one transaction.
    await tx.query("SET LOCAL fb.import = 'on'");
    const dupe = await tx.query('SELECT 1 FROM entity WHERE org_id = $1 AND lower(name) = lower($2)', [orgId, companyName]);
    if (dupe.rowCount) throw new ImportError(`A company named “${companyName}” already exists. Delete it first to import again.`);
    const { rows: [e] } = await tx.query('INSERT INTO entity (org_id, name, time_zone) VALUES ($1, $2, $3) RETURNING entity_id', [orgId, companyName, timeZone]);
    const entityId = Number(e.entity_id);
    await tx.query(`INSERT INTO terms (org_id, entity_id, name, due_days) SELECT $1, $2, n, d FROM (VALUES ('Due on receipt', 0), ('Net 15', 15), ('Net 30', 30), ('Net 60', 60)) v(n, d)`, [orgId, entityId]);

    // ---- accounts ----
    const byName = new Map(); // QuickBooks full name (and "number name") → { id, type }
    const used = new Set(data.txns.flatMap(t => t.lines.map(l => l.account)));
    // QuickBooks writes a numbered account as “0487 Name” in its reports.
    const known = new Set(data.accounts.flatMap(a => [a.fullName, ...(a.number ? [`${a.number} ${a.fullName}`] : [])]));
    const missing = [...used].filter(n => !known.has(n));
    if (missing.length) throw new ImportError(`The Journal uses accounts that aren’t in the chart of accounts (deleted ones need the Account List with deleted accounts): ${missing.join('; ')}`);
    const depth = a => a.fullName.split(':').length;
    // Names are unique per company here; QuickBooks only per parent ("Westside:Equity" and "Equity"). A repeat becomes "Equity (Westside)".
    const taken = new Set();
    const uniqueName = (name, parent) => {
      let n = name;
      if (taken.has(n.toLowerCase()) && parent) n = `${name} (${parent})`;
      for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${name} ${i}`;
      taken.add(n.toLowerCase());
      return n;
    };
    const renamed = [];
    for (const a of [...data.accounts].sort((x, y) => depth(x) - depth(y))) {
      const type = ourType(a);
      if (!type) throw new ImportError(`Unknown QuickBooks account type “${a.type}” (${a.fullName}).`);
      // Sub-accounts go one level deep here (QuickBooks allows five): a deeper account sits under its top-level account,
      // named with the levels between ("Sales:Westside:SD Sales" → "Westside: SD Sales" under Sales).
      const path = a.fullName.split(':');
      const top = path.length > 1 ? path[0] : null;
      const parentId = top ? byName.get(top)?.id ?? null : null;
      if (top && !parentId) throw new ImportError(`The parent account “${top}” of “${a.fullName}” isn’t in the chart of accounts.`);
      const name = uniqueName(path.length > 2 ? path.slice(1).join(': ') : path.at(-1), top);
      if (name !== path.at(-1)) renamed.push(`${a.fullName} → ${name}`);
      const key = a.deleted ? null : systemKeyOf(a);
      const { rows: [r] } = await tx.query(`INSERT INTO account (org_id, entity_id, name, number, type, parent_id, system_key, description, active) VALUES ($1,$2,$3,$9,$4,$5,$6,$7,$8) RETURNING account_id`,
        [orgId, entityId, name, type, parentId, key, a.description ?? a.detail ?? null, !a.deleted, a.number ?? null]);
      byName.set(a.fullName, { id: Number(r.account_id), type });
      if (a.number) byName.set(`${a.number} ${a.fullName}`, { id: Number(r.account_id), type });
    }
    // The app's own accounts this company doesn't have yet: QuickBooks' account of that name and type becomes it
    // (its "Sales" income account is the system Sales); a same-named account of another kind keeps its name and the
    // system one is added as "<name> (system)".
    for (const a of SYSTEM_ACCOUNTS) {
      const have = await tx.query('SELECT 1 FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key = $3', [orgId, entityId, a.key]);
      if (have.rowCount) continue;
      const { rows: [same] } = await tx.query('SELECT account_id, type, parent_id FROM account WHERE org_id = $1 AND entity_id = $2 AND lower(name) = lower($3)', [orgId, entityId, a.name]);
      if (same && same.type === a.type && !same.parent_id) await tx.query('UPDATE account SET system_key = $2 WHERE account_id = $1', [same.account_id, a.key]);
      else if (same) await tx.query('INSERT INTO account (org_id, entity_id, name, type, system_key) VALUES ($1,$2,$3,$4,$5)', [orgId, entityId, `${a.name} (system)`, a.type, a.key]);
    }
    const sys = await ensureSystemAccounts(tx, orgId, entityId);

    // ---- customers and vendors ----
    const customers = new Map(), vendors = new Map();
    const addCustomer = async c => {
      if (customers.has(c.name)) return customers.get(c.name);
      const [first, ...rest] = String(c.fullName ?? '').trim().split(/\s+/).filter(Boolean);
      const { rows: [r] } = await tx.query(`INSERT INTO customer (org_id, entity_id, display_name, email, phone, billing_address, shipping_address, shipping_same_as_billing, first_name, last_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING customer_id`,
      [orgId, entityId, c.name, firstEmail(c.email), c.phone ?? null, address(c.address), address(c.shipping), !c.shipping || c.shipping === c.address, first ?? null, rest.join(' ') || null]);
      customers.set(c.name, Number(r.customer_id));
      return Number(r.customer_id);
    };
    const addVendor = async v => {
      if (vendors.has(v.name)) return vendors.get(v.name);
      const { rows: [r] } = await tx.query(`INSERT INTO vendor (org_id, entity_id, display_name, email, phone, account_no, billing_address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING vendor_id`,
        [orgId, entityId, v.name, firstEmail(v.email), v.phone ?? null, v.account ?? null, address(v.address), contactNote(v)]);
      vendors.set(v.name, Number(r.vendor_id));
      return Number(r.vendor_id);
    };
    for (const c of data.customers) await addCustomer(c);
    for (const v of [...data.vendors, ...data.employees]) await addVendor(v);

    // Resolve unlisted names from the complete export, before any native/fallback
    // decision. Customer use wins for an unlisted mixed-use name; listed namespaces
    // remain distinct. This policy is recorded with lossless source identity below.
    const customerTypes = new Set(['Invoice','Payment','Sales Receipt','Credit Memo','Refund','Deposit']);
    const inferred = new Map();
    for (const q of data.txns) for (const n of [q.name,...q.lines.map(l=>l.name)].filter(Boolean)) {
      if (!customers.has(n) && !vendors.has(n)) inferred.set(n,(inferred.get(n)??false)||customerTypes.has(q.type));
    }
    for (const [n,customer] of [...inferred].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
      if (customer) await addCustomer({name:n}); else await addVendor({name:n});
    }
    const customerNames=new Map([...customers].map(([n,key])=>[key,n])), vendorNames=new Map([...vendors].map(([n,key])=>[key,n]));
    const sourceParties = (q,plan={}) => {
      if (plan.customerId) return [{kind:'customer',name:customerNames.get(plan.customerId)}];
      if (plan.vendorId) return [{kind:'vendor',name:vendorNames.get(plan.vendorId)}];
      // The Journal's first row is also a line, not proof of a document-level
      // party. Without a native header retain every named line (including Paid to/From).
      return [...new Set([q.name,...q.lines.map(l=>l.name)].filter(Boolean))].sort().map(n=>({
        kind:customers.has(n)&&(customerTypes.has(q.type)||!vendors.has(n))?'customer':'vendor',name:n,
      }));
    };
    const referenceIdentity = {version:1,partyPolicy:'complete-input-customer-use-v1',transactions:[]};

    // ---- transactions ----
    const counts = {}, fallbacks = {}, docClash = [], omitted = [];
    const usedDocs = new Set();
    const ids = [];
    const docs = []; // { txnId, type, total, date, customerId, vendorId, q } for the subledgers
    const jeItems = []; // journal entry lines on A/R or A/P: { txnId, lineNo, side, kind (charge|credit), left, party, date }
    const insert = async (q, plan, { companionOf = null, extraMemo = null } = {}) => {
      // Numbers that must be unique keep QuickBooks' number in the memo when it repeats.
      let doc = companionOf ? null : q.num ? String(q.num).slice(0, 30) : null;
      if (doc) {
        const scope = plan.type === 'check' || (plan.type === 'bill_payment' && plan.paymentMethod === 'Check') ? `check:${plan.accountId}`
          : ['expense', 'bill', 'vendor_credit', 'cc_credit'].includes(plan.type) ? null : `${plan.type}`;
        if (scope) {
          if (usedDocs.has(`${scope}:${doc}`)) { docClash.push(`${q.type} ${q.date} no. ${doc}`); doc = null; } else usedDocs.add(`${scope}:${doc}`);
        }
      }
      const memo = companionOf ? `Cost of goods sold for ${companionOf.label}`
        : [q.memo, !doc && q.num ? `QuickBooks no. ${q.num}` : null, plan.memoExtra, extraMemo].filter(Boolean).join(' · ').slice(0, 1000) || null;
      const { rows: [t] } = await tx.query(
        `INSERT INTO txn (org_id, entity_id, type, doc_number, txn_date, due_date, memo, total_cents, open_cents, account_id, to_account_id, vendor_id, customer_id, payment_method,
           cash_back_account_id, cash_back_cents, source, source_type, approval_status, companion_of_txn_id, printed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14,$15,'qbo_import',$16,$17,$18,
           CASE WHEN $3 = 'check' OR ($3 = 'bill_payment' AND $13 = 'Check') THEN $5::date::timestamptz END) RETURNING txn_id`,
        [orgId, entityId, plan.type, doc, q.date, ['invoice', 'bill'].includes(plan.type) ? q.date : null, memo, plan.total, plan.accountId ?? null, plan.toAccountId ?? null,
          plan.vendorId ?? null, plan.customerId ?? null, plan.paymentMethod ?? null, plan.cashBackAccountId ?? null, plan.cashBack ?? 0, companionOf ? 'Journal Entry' : q.type,
          plan.type === 'bill' ? 'approved' : null, companionOf?.txnId ?? null]);
      const txnId = Number(t.txn_id);
      if (!companionOf) referenceIdentity.transactions.push({txnId,number:q.num == null ? null : String(q.num),party:sourceParties(q,plan)});
      for (const [i, l] of (plan.lines ?? []).entries()) {
        // Quantity 1 at the line's own (signed) amount: quantity × rate is the amount.
        await tx.query(`INSERT INTO txn_line (org_id, txn_id, line_no, account_id, description, quantity, rate_cents, amount_cents, customer_id, vendor_id)
          VALUES ($1,$2,$3,$4,$5,1,$6,$6,$7,$8)`, [orgId, txnId, i + 1, l.accountId, l.description ?? null, l.amount, l.customerId ?? null, l.vendorId ?? null]);
      }
      for (const [i, d] of (plan.depositLines ?? []).entries()) {
        await tx.query(`INSERT INTO deposit_line (org_id, deposit_txn_id, line_no, account_id, customer_id, description, amount_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [orgId, txnId, i + 1, d.accountId, d.customerId ?? null, d.description ?? null, d.amount]);
      }
      ids.push(txnId);
      // Other transactions with A/R or A/P lines (journal entries, a refund check to a customer): QuickBooks counts those
      // lines as open items too, for the line's name or else the transaction's.
      if (!companionOf && ['journal_entry', 'expense', 'check'].includes(plan.type)) {
        for (const [i, l] of plan.lines.entries()) {
          if (Number(l.accountId) === Number(sys.ar)) jeItems.push({ txnId, lineNo: i + 1, side: 'ar', kind: l.amount > 0 ? 'charge' : 'credit', left: Math.abs(l.amount), party: l.customerId ?? customers.get(q.name) ?? null, date: q.date, q });
          if (Number(l.accountId) === Number(sys.ap)) jeItems.push({ txnId, lineNo: i + 1, side: 'ap', kind: l.amount < 0 ? 'charge' : 'credit', left: Math.abs(l.amount), party: l.vendorId ?? vendors.get(q.name) ?? null, date: q.date, q });
        }
      }
      counts[plan.type] = (counts[plan.type] ?? 0) + 1;
      if (!companionOf && (CHARGE_TYPES.ar.includes(plan.type) || CHARGE_TYPES.ap.includes(plan.type) || CREDIT_TYPES.ar.includes(plan.type) || CREDIT_TYPES.ap.includes(plan.type))) {
        docs.push({ txnId, type: plan.type, total: plan.total, date: q.date, customerId: plan.customerId ?? null, vendorId: plan.vendorId ?? null, q });
      }
      return txnId;
    };
    for (const q of data.txns) {
      // Lines with no amount post nothing; their words are kept in the memo.
      const words = q.lines.filter(l => !l.debit && !l.credit).map(l => l.memo).filter(Boolean);
      const lines = q.lines.filter(l => l.debit || l.credit).map(l => ({ ...l, accountId: byName.get(l.account).id, accountType: byName.get(l.account).type, amount: l.debit - l.credit }));
      if (!lines.length) {
        omitted.push({ row: q.row, date: q.date, type: q.type, num: q.num, name: q.name, memo: q.memo, party:sourceParties(q), reason: 'no amounts (QuickBooks shows it with $0.00, often a voided transaction)', lines: q.lines.map(l => l.account) });
        continue;
      }
      const extraMemo = words.length ? `Also on it: ${[...new Set(words)].join('; ')}`.slice(0, 400) : null;
      const name = q.name ?? lines.find(l => l.name)?.name ?? null;
      const partyFor = async (n, preferCustomer) => {
        if (!n) return {};
        if (customers.has(n) && (preferCustomer || !vendors.has(n))) return { customerId: customers.get(n) };
        if (vendors.has(n)) return { vendorId: vendors.get(n) };
        return preferCustomer ? { customerId: await addCustomer({ name: n }) } : { vendorId: await addVendor({ name: n }) };
      };
      let plan = await nativePlan({ q, lines, name, partyFor, customers, vendors, sys });
      // A sale's cost of goods (COGS debit / Inventory credit) rides along in QuickBooks; here it's its own journal entry.
      if (plan && !samePostings(plan, net(lines.filter(l => !plan.companion?.includes(l)).map(l => [l.accountId, l.amount])), sys)) plan = null;
      if (!plan) {
        plan = await journalPlan({ q, lines, partyFor });
        fallbacks[q.type] = (fallbacks[q.type] ?? 0) + 1;
      }
      const txnId = await insert(q, plan, { extraMemo });
      if (plan.companion?.length) {
        await insert(q, await journalPlan({ q, lines: plan.companion, partyFor }), { companionOf: { txnId, label: `${q.type}${q.num ? ` ${q.num}` : ''}` } });
      }
    }
    await repostMany(tx, orgId, ids);

    // ---- proof: every account here equals the Journal ----
    const want = net(data.txns.flatMap(q => q.lines.filter(l => l.debit || l.credit).map(l => [byName.get(l.account).id, l.debit - l.credit])));
    const { rows: got } = await tx.query('SELECT account_id, sum(amount_cents)::bigint AS s FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) GROUP BY account_id', [orgId, ids]);
    const have = new Map(got.map(r => [Number(r.account_id), Number(r.s)]).filter(([, s]) => s !== 0));
    const off = [...new Set([...want.keys(), ...have.keys()])].filter(k => (want.get(k) ?? 0) !== (have.get(k) ?? 0));
    if (off.length) throw new ImportError(`After import, ${off.length} account(s) don’t match the Journal: ${off.join(', ')}.`);

    // ---- proof: every account equals QuickBooks' Trial Balance (all dates) ----
    if (!data.trialBalance) throw new ImportError('Trial_balance.xlsx (All dates) is needed to check the import.');
    const accountIds = Object.fromEntries([...byName].map(([k, v]) => [k, v.id]));
    const parity = trialBalanceCheck(data.trialBalance, accountIds, have);
    const unaccepted = parity.filter(m => !acceptMismatches.includes(m.account));
    if (unaccepted.length) {
      throw new ImportError(`The books don’t match QuickBooks’ Trial Balance for ${unaccepted.length} account(s), so nothing was imported:\n  ${unaccepted.map(m => m.text).join('\n  ')}`);
    }

    // ---- open items: QuickBooks' A/R and A/P aging decide what's still open; links are rebuilt to match ----
    for (const [side, key, label] of [['ar', 'ar', 'Accounts receivable'], ['ap', 'ap', 'Accounts payable']]) {
      const given = data.hasAging ? data.hasAging[side] : (data.openItems ?? []).some(o => o.side === side);
      if ((have.get(Number(sys[key])) ?? 0) && !given) {
        throw new ImportError(`${label} isn’t zero, so QuickBooks’ ${label.toLowerCase()} aging detail report is needed to know what’s still open.`);
      }
    }
    const subledger = await settleSubledgers(tx, { orgId, entityId, docs, jeItems, openItems: data.openItems ?? [] });
    // What's open here — the app's own open documents, checked with the same reconciliation the app shows — must equal
    // QuickBooks' aging in total and party by party, every open item must be found and representable, and the open
    // documents must add up to the A/R and A/P ledger balances. A difference stops the import unless it's accepted.
    const accepted = parity.filter(m => acceptMismatches.includes(m.account)).map(m => m.text);
    const check = await ledgerCheck(tx, { orgId, entityId });
    for (const [side, label] of [['ar', 'A/R open items'], ['ap', 'A/P open items']]) {
      const s = subledger.summary[side];
      const problems = [
        s.open !== s.qbo ? `${(s.open / 100).toFixed(2)} open here vs ${(s.qbo / 100).toFixed(2)} in QuickBooks’ aging report` : null,
        ...subledger.unmatched.filter(u => u.startsWith(side)),
        ...subledger.unrepresentable.filter(u => u.startsWith(side)),
        ...subledger.partyMismatches.filter(m => m.startsWith(side)),
        !check[`${side}Matches`] ? `the open documents add up to ${(check[`${side}Open`] / 100).toFixed(2)} but the ${side === 'ar' ? 'A/R' : 'A/P'} ledger is ${(check[`${side}Ledger`] / 100).toFixed(2)}` : null,
      ].filter(Boolean);
      if (!problems.length) continue;
      if (!acceptMismatches.includes(label)) throw new ImportError(`${label}: ${problems.slice(0, 40).join('\n  ')}\nNothing was imported.`);
      accepted.push(...problems.map(p => `${label}: ${p}`));
    }

    // An open row that more than one document could be: which one is open is a guess, so it has to be accepted.
    if (subledger.summary.ambiguousItems?.length) {
      const text = `open items that more than one document could be (same type, date, number and name): ${subledger.summary.ambiguousItems.join('; ')}`;
      if (!acceptMismatches.includes('Ambiguous open items')) throw new ImportError(`Ambiguous ${text}. Nothing was imported.`);
      accepted.push(`Ambiguous ${text}`);
    }

    // ---- payments and sales receipts still waiting in Undeposited Funds ----
    // QuickBooks' exports don't say which payments are still in Undeposited Funds, only how much is. So any money there
    // stops the import unless that's accepted; then the payments adding up to it exactly (if any) are the ones waiting.
    const undeposited = await markUndeposited(tx, { orgId, entityId, sys, ids });
    if (undeposited.balance) {
      const text = undeposited.searchGaveUp
        ? `Undeposited Funds holds ${(undeposited.balance / 100).toFixed(2)}; there are too many imported payments to work out which ones add up to it, so none are marked waiting (the money stays in Undeposited Funds)`
        : undeposited.unexplained
        ? `Undeposited Funds holds ${(undeposited.balance / 100).toFixed(2)}, which no set of imported payments adds up to exactly`
        : `Undeposited Funds holds ${(undeposited.balance / 100).toFixed(2)}: the ${undeposited.waiting} payment(s) adding up to it are left waiting, chosen by amount`;
      if (!acceptMismatches.includes('Undeposited Funds')) throw new ImportError(`${text}. Nothing was imported.`);
      accepted.push(text);
    }

    const { rows: [range] } = await tx.query(`SELECT min(txn_date)::text AS "from", max(txn_date)::text AS "to"
      FROM txn WHERE org_id=$1 AND entity_id=$2 AND source='qbo_import'`, [orgId, entityId]);
    const summary = {
      transactions: ids.length, byType: counts, savedAsJournalEntries: fallbacks, omitted: omitted.length, numbersMovedToMemo: docClash.length,
      accounts: data.accounts.length, renamedAccounts: renamed.length, customers: customers.size, vendors: vendors.size,
      from: range.from, to: range.to, openItems: subledger.summary, undeposited,
      acceptedMismatches: accepted, acceptedNames: acceptMismatches,
    };
    await tx.query(`INSERT INTO import_batch (org_id, entity_id, source, company_name, summary, parity, imported_by) VALUES ($1,$2,'qbo_import',$3,$4,$5,$6)`,
      [orgId, entityId, companyName, JSON.stringify({ ...summary, referenceIdentity, omittedTransactions: omitted, renamed, docClash, unmatchedOpenItems: subledger.unmatched, partyGaps: subledger.gaps }),
        JSON.stringify({ trialBalance: parity.length ? parity.map(m => m.text) : 'all accounts match', subledgers: subledger.summary }), actor]);
    return { entityId, summary, docClash, omitted, renamed, parity, subledger, accountIds };
  });
}

// Every account in QuickBooks' Trial Balance vs. this import's postings → [{ account, text }] for the ones that differ.
function trialBalanceCheck(trialBalance, accountIds, have) {
  const out = [], seen = new Set();
  for (const [name, qbo] of Object.entries(trialBalance)) {
    const id = accountIds[name];
    if (id) seen.add(id);
    const here = id ? have.get(id) ?? 0 : 0;
    if (here !== qbo) out.push({ account: name, text: `${name}: QuickBooks ${(qbo / 100).toFixed(2)}, here ${(here / 100).toFixed(2)}${id ? '' : ' (no such account)'}` });
  }
  for (const [id, bal] of have) {
    if (!seen.has(id) && bal) {
      const name = Object.keys(accountIds).find(k => accountIds[k] === id);
      out.push({ account: name, text: `${name}: not on QuickBooks’ Trial Balance, here ${(bal / 100).toFixed(2)}` });
    }
  }
  return out;
}

// A document's identity across QuickBooks' exports: type, date, number (numbers compared as numbers: the Journal drops
// leading zeros the aging report keeps) and name.
const normNum = n => (n === null || n === undefined || n === '' ? '' : /^\d+$/.test(String(n).trim()) ? String(n).trim().replace(/^0+(?=\d)/, '') : String(n).trim());
const openKey = o => [o.type, o.date, normNum(o.num), o.name ?? ''].join('|');

// Sets every imported invoice/bill/credit's open amount from QuickBooks' aging reports and rebuilds the links (oldest
// charge first, never dated before either side) so each party's documents settle to exactly those amounts.
async function settleSubledgers(tx, { orgId, entityId, docs, jeItems, openItems }) {
  // 1. QuickBooks' open rows → the open amount each document (or other A/R / A/P line) keeps.
  const want = new Map(); // key → [aging rows]
  for (const o of openItems) {
    const k = openKey(o);
    if (!want.has(k)) want.set(k, []);
    want.get(k).push(o);
  }
  const target = new Map(), dueOf = new Map(), unmatched = [], ambiguous = [];
  const isCreditDoc = d => CREDIT_TYPES.ar.includes(d.type) || CREDIT_TYPES.ap.includes(d.type);
  const candidates = new Map();
  for (const d of docs) {
    const k = openKey({ type: d.q.type, date: d.q.date, num: d.q.num, name: d.q.name });
    candidates.set(k, (candidates.get(k) ?? 0) + 1);
  }
  for (const d of docs) {
    const k = openKey({ type: d.q.type, date: d.q.date, num: d.q.num, name: d.q.name });
    const list = want.get(k);
    if (!list?.length) continue;
    // An open row that more than one document could be (same type, date, number and name), or repeated open rows:
    // which is which can't be told from the exports. Reported, and the import stops unless that's accepted.
    if ((list.length > 1 || candidates.get(k) > 1) && !ambiguous.includes(k)) ambiguous.push(k);
    const o = list.shift();
    const amount = isCreditDoc(d) ? -o.open : o.open; // credits show as negative open balances
    if (amount <= 0 || amount > d.total) { o.misfit = `doesn’t fit the ${d.type} of ${(d.total / 100).toFixed(2)}`; list.unshift(o); continue; }
    target.set(d.txnId, amount);
    if (o.due && o.due >= d.date) dueOf.set(d.txnId, o.due);
  }
  const itemOpen = new Map();
  for (const j of jeItems) {
    const list = want.get(openKey({ type: j.q.type, date: j.q.date, num: j.q.num, name: j.q.name }));
    const o = list?.find(x => x.side === j.side && (j.kind === 'credit' ? -x.open : x.open) > 0 && (j.kind === 'credit' ? -x.open : x.open) <= j.left);
    if (!o) continue;
    list.splice(list.indexOf(o), 1);
    const amount = j.kind === 'credit' ? -o.open : o.open;
    itemOpen.set(j, amount);
    j.left -= amount;
  }
  for (const [k, list] of want) for (const o of list) unmatched.push(`${o.side} ${k}: ${(o.open / 100).toFixed(2)} open in QuickBooks, ${o.misfit ?? 'no matching document here'}`);
  // QuickBooks can leave a journal entry or check open on A/R or A/P (a refund check next to an unapplied payment, say).
  // Only documents can be open here, so it's set against the same party's opposite open document (both close, the
  // party's balance is unchanged); what can't be is reported — the import then stops unless that's accepted.
  const offsets = [], unrepresentable = [], offsetUsed = new Map();
  for (const [j, amount] of itemOpen) {
    let left = amount;
    for (const d of docs) {
      if (!left) break;
      const party = j.side === 'ar' ? d.customerId : d.vendorId;
      const opposite = j.kind === 'charge' ? isCreditDoc(d) : !isCreditDoc(d);
      if (party !== j.party || !opposite || !target.get(d.txnId) || ![...CHARGE_TYPES[j.side], ...CREDIT_TYPES[j.side]].includes(d.type)) continue;
      const take = Math.min(left, target.get(d.txnId));
      offsets.push({ item: j, doc: d, take });
      offsetUsed.set(d.txnId, (offsetUsed.get(d.txnId) ?? 0) + take);
      target.set(d.txnId, target.get(d.txnId) - take);
      left -= take;
    }
    itemOpen.set(j, left);
    if (left) unrepresentable.push(`${j.side} ${j.q.type} ${j.q.date} ${j.q.num ?? ''} ${j.q.name ?? ''}: ${(left / 100).toFixed(2)} open in QuickBooks, which only documents can be here`);
  }

  const summary = { ar: { open: 0, qbo: 0 }, ap: { open: 0, qbo: 0 }, links: 0, linksToOtherTransactions: 0, linksByAmount: 0, linksForReview: 0, linksBetweenOtherTransactions: 0 }, gaps = [];
  for (const o of openItems) summary[o.side === 'ap' ? 'ap' : 'ar'].qbo += o.open;
  // A link to another transaction's A/R or A/P line names that line, so it settles only that line (an entry can have
  // lines on A/R and A/P, or for several names).
  const link = async (credit, charge, amount, date, how, { creditLine = null, chargeLine = null } = {}) => {
    await tx.query(`INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on, source, credit_line_no, charge_line_no)
      VALUES ($1,$2,$3,$4,$5,'qbo_import',$6,$7)`, [orgId, credit, charge, amount, date, creditLine, chargeLine]);
    summary.links++;
    if (how) summary[how]++;
  };
  const later = (a, b) => (a > b ? a : b);
  for (const { item: j, doc: d, take } of offsets) {
    if (j.kind === 'charge') await link(d.txnId, j.txnId, take, later(d.date, j.date), 'linksToOtherTransactions', { chargeLine: j.lineNo });
    else await link(j.txnId, d.txnId, take, later(d.date, j.date), 'linksToOtherTransactions', { creditLine: j.lineNo });
  }
  summary.offsetOpenItems = offsets.length;
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.txnId - b.txnId;
  const rest = new Map(); // txnId → amount still to settle (beyond what stays open)
  const parties = [];
  for (const side of ['ar', 'ap']) {
    const partyOf = d => (side === 'ar' ? d.customerId : d.vendorId);
    const byParty = new Map();
    for (const d of docs) {
      if (![...CHARGE_TYPES[side], ...CREDIT_TYPES[side]].includes(d.type) || !partyOf(d)) continue;
      if (!byParty.has(partyOf(d))) byParty.set(partyOf(d), { side, party: partyOf(d), charges: [], credits: [] });
      byParty.get(partyOf(d))[isCreditDoc(d) ? 'credits' : 'charges'].push(d);
    }
    for (const p of byParty.values()) {
      p.charges.sort(byDate);
      p.credits.sort(byDate);
      for (const d of [...p.charges, ...p.credits]) rest.set(d.txnId, d.total - (target.get(d.txnId) ?? 0) - (offsetUsed.get(d.txnId) ?? 0));
      // 2a. The party's own credits against its own charges: charges dated on or before the credit first (oldest
      // first), then later ones.
      for (const cr of p.credits) {
        for (const ch of [...p.charges.filter(c => c.date <= cr.date), ...p.charges.filter(c => c.date > cr.date)]) {
          const take = Math.min(rest.get(cr.txnId), rest.get(ch.txnId));
          if (take <= 0) continue;
          await link(cr.txnId, ch.txnId, take, later(cr.date, ch.date));
          rest.set(cr.txnId, rest.get(cr.txnId) - take);
          rest.set(ch.txnId, rest.get(ch.txnId) - take);
          if (!rest.get(cr.txnId)) break;
        }
      }
      // 2b. The party's own other A/R or A/P lines (a journal entry, a refund check): QuickBooks lets them settle documents too.
      for (const [kind, list] of [['charge', p.credits], ['credit', p.charges]]) {
        for (const d of list) {
          for (const j of jeItems.filter(x => x.side === side && x.kind === kind && x.party === p.party && x.left > 0)) {
            const take = Math.min(rest.get(d.txnId), j.left);
            if (take <= 0) break;
            if (kind === 'charge') await link(d.txnId, j.txnId, take, later(d.date, j.date), 'linksToOtherTransactions', { chargeLine: j.lineNo });
            else await link(j.txnId, d.txnId, take, later(d.date, j.date), 'linksToOtherTransactions', { creditLine: j.lineNo });
            j.left -= take;
            rest.set(d.txnId, rest.get(d.txnId) - take);
          }
        }
      }
      parties.push(p);
    }
  }
  // 2c. QuickBooks' exports leave the name off some journal-entry lines (a write-off, a returned payment). Each party
  // whose documents still don't settle takes the unnamed lines that add up to exactly its difference — reported.
  const unnamed = jeItems.filter(j => !j.party && j.left > 0);
  for (const p of parties.sort((a, b) => b.charges.length + b.credits.length - a.charges.length - a.credits.length)) {
    const charged = p.charges.reduce((s, d) => s + rest.get(d.txnId), 0), credited = p.credits.reduce((s, d) => s + rest.get(d.txnId), 0);
    const gap = credited - charged; // > 0: credits left over, so unnamed charges settle them; < 0: unnamed credits
    if (!gap) continue;
    const pool = unnamed.filter(j => j.side === p.side && j.left > 0 && (gap > 0 ? j.kind === 'charge' : j.kind === 'credit'));
    const pick = subsetSum(pool.map(j => j.left), Math.abs(gap));
    if (!Array.isArray(pick)) continue;
    const used = pick.map(i => pool[i]);
    for (const j of used) {
      for (const d of gap > 0 ? p.credits : p.charges) {
        const take = Math.min(rest.get(d.txnId), j.left);
        if (take <= 0) continue;
        if (gap > 0) await link(d.txnId, j.txnId, take, later(d.date, j.date), 'linksByAmount', { chargeLine: j.lineNo });
        else await link(j.txnId, d.txnId, take, later(d.date, j.date), 'linksByAmount', { creditLine: j.lineNo });
        j.left -= take;
        j.inferred = p.party;
        rest.set(d.txnId, rest.get(d.txnId) - take);
        if (!j.left) break;
      }
    }
    gaps.push({ side: p.side, party: p.party, settledByUnnamedLines: used.map(j => ({ txnId: j.txnId, amount: j.left === 0 ? undefined : j.left })), amount: Math.abs(gap) });
  }

  // 2d. Still unsettled: QuickBooks counts these documents as settled, by unnamed lines whose amounts don't single them
  // out. They take the remaining unnamed lines, oldest first, so every party's open balance is QuickBooks' — each such
  // link is listed for review.
  const review = [];
  for (const p of parties) {
    for (const [kind, list] of [['charge', p.credits], ['credit', p.charges]]) {
      for (const d of list) {
        for (const j of unnamed.filter(x => x.side === p.side && x.kind === kind && x.left > 0).sort((a, b) => a.date.localeCompare(b.date))) {
          const take = Math.min(rest.get(d.txnId), j.left);
          if (take <= 0) break;
          if (kind === 'charge') await link(d.txnId, j.txnId, take, later(d.date, j.date), 'linksForReview', { chargeLine: j.lineNo });
          else await link(j.txnId, d.txnId, take, later(d.date, j.date), 'linksForReview', { creditLine: j.lineNo });
          j.left -= take;
          j.inferred = p.party;
          rest.set(d.txnId, rest.get(d.txnId) - take);
          review.push({ side: p.side, party: p.party, document: d.txnId, otherTransaction: j.txnId, amount: take });
        }
      }
    }
  }
  if (review.length) gaps.push({ linkedByAmountForReview: review });
  // 2e. What's left on other transactions' A/R or A/P lines (an allowance and its later reversal, say) QuickBooks settled
  // against each other: paired oldest first, the same party first, else a line without a name — never two named parties.
  const paired = [];
  const key = j => j.party ?? j.inferred ?? null;
  for (const side of ['ar', 'ap']) {
    const left = jeItems.filter(j => j.side === side && j.left > 0).sort((a, b) => a.date.localeCompare(b.date) || a.txnId - b.txnId);
    const credits = left.filter(j => j.kind === 'credit'), charges = left.filter(j => j.kind === 'charge');
    for (const cr of [...credits.filter(j => key(j)), ...credits.filter(j => !key(j))]) {
      const order = key(cr)
        ? [...charges.filter(ch => key(ch) === key(cr)), ...charges.filter(ch => !key(ch))]
        : [...charges.filter(ch => !key(ch)), ...charges.filter(ch => key(ch))];
      for (const ch of order) {
        if (!cr.left) break;
        if (ch.txnId === cr.txnId || !ch.left) continue;
        const take = Math.min(cr.left, ch.left);
        await link(cr.txnId, ch.txnId, take, later(cr.date, ch.date), 'linksBetweenOtherTransactions', { creditLine: cr.lineNo, chargeLine: ch.lineNo });
        cr.left -= take;
        ch.left -= take;
        paired.push({ side, credit: cr.txnId, charge: ch.txnId, amount: take });
      }
    }
  }
  if (paired.length) gaps.push({ otherLinesPairedForReview: paired });

  // 3. Open amounts: what QuickBooks says stays open, plus anything that couldn't be settled (reported).
  for (const p of parties) {
    const stillCharged = p.charges.reduce((s, d) => s + rest.get(d.txnId), 0), stillCredit = p.credits.reduce((s, d) => s + rest.get(d.txnId), 0);
    if (stillCharged || stillCredit) gaps.push({ side: p.side, party: p.party, unsettledCharges: stillCharged, unsettledCredits: stillCredit });
    for (const d of [...p.charges, ...p.credits]) {
      const open = (target.get(d.txnId) ?? 0) + rest.get(d.txnId);
      if (open) await tx.query('UPDATE txn SET open_cents = $3 WHERE org_id = $1 AND txn_id = $2', [orgId, d.txnId, open]);
      summary[p.side].open += isCreditDoc(d) ? -open : open;
    }
  }
  // Each customer's and vendor's open balance as the app's own A/R and A/P reports show it (documents, plus any open line
  // on another transaction) vs. QuickBooks' aging for that name.
  // Every open item on its own, too: nothing settled past its amount or turned around (balances that cancel in a
  // party's total can still be wrong rows in the aging and collections).
  const qboBy = new Map(), hereBy = new Map(), overSettled = [];
  for (const o of openItems) qboBy.set(`${o.side}|${o.name}`, (qboBy.get(`${o.side}|${o.name}`) ?? 0) + o.open);
  for (const side of ['ar', 'ap']) {
    for (const i of await reportOpenItems(tx, { orgId, entityId, side, asOf: '9999-12-31' })) {
      const k = `${side}|${i.partyName}`;
      hereBy.set(k, (hereBy.get(k) ?? 0) + i.open);
      if (i.total > 0 ? i.open < 0 || i.open > i.total : i.open > 0 || i.open < i.total) {
        overSettled.push(`${side} ${i.typeLabel ?? i.type} ${i.date} ${i.num} ${i.partyName}: ${(i.open / 100).toFixed(2)} open of ${(i.total / 100).toFixed(2)}`);
      }
    }
  }
  const partyMismatches = [...new Set([...qboBy.keys(), ...hereBy.keys()])].filter(k => (qboBy.get(k) ?? 0) !== (hereBy.get(k) ?? 0))
    .map(k => `${k.replace('|', ' ')}: ${((hereBy.get(k) ?? 0) / 100).toFixed(2)} open here, ${((qboBy.get(k) ?? 0) / 100).toFixed(2)} in QuickBooks`)
    .concat(overSettled);
  summary.partyMismatches = partyMismatches.length;
  // QuickBooks' open amounts on other transactions count in the totals (they can't be paid here; reported).
  for (const [j, amount] of itemOpen) summary[j.side].open += j.kind === 'charge' ? amount : -amount;
  summary.openOnOtherTransactions = itemOpen.size;
  const stray = jeItems.filter(j => j.left > 0);
  if (stray.length) gaps.push({ unsettledOtherLines: stray.map(j => ({ txnId: j.txnId, side: j.side, kind: j.kind, amount: j.left, party: j.party })) });
  for (const [id, due] of dueOf) await tx.query('UPDATE txn SET due_date = $3 WHERE org_id = $1 AND txn_id = $2', [orgId, id, due]);
  summary.unmatched = unmatched.length;
  summary.ambiguous = ambiguous.length;
  summary.ambiguousItems = ambiguous;
  return { summary, unmatched, gaps, partyMismatches, unrepresentable };
}

// Indexes of values adding up to exactly `goal` (fewest first), or null when no set does. The search is bounded: when
// it gives up first, the result is { exhausted: true } — not proof that no set adds up.
function subsetSum(values, goal) {
  const order = values.map((v, i) => [v, i]).filter(([v]) => v <= goal).sort((a, b) => b[0] - a[0]);
  if (order.reduce((t, [v]) => t + v, 0) < goal) return null;
  let nodes = 0;
  for (let size = 1; size <= order.length; size++) {
    const pick = [];
    const dfs = (start, left) => {
      if (++nodes > 2000000) return false;
      if (pick.length === size) return left === 0;
      for (let k = start; k < order.length; k++) {
        // equal amounts are interchangeable: try each amount once at this position
        if (order[k][0] > left || (k > start && order[k][0] === order[k - 1][0])) continue;
        pick.push(order[k][1]);
        if (dfs(k + 1, left - order[k][0])) return true;
        pick.pop();
      }
      return false;
    };
    if (dfs(0, goal)) return pick;
    if (nodes > 2000000) return { exhausted: true };
  }
  return null;
}

// Imported payments and sales receipts in Undeposited Funds were deposited in QuickBooks (by its deposits, which come
// over as journal entries). If the account still holds money, the latest ones adding up to that amount are still waiting.
async function markUndeposited(tx, { orgId, entityId, sys, ids }) {
  const { rows: [b] } = await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM posting WHERE org_id = $1 AND account_id = $2', [orgId, sys.undeposited]);
  const balance = Number(b.s);
  if (!balance) return { balance: 0, waiting: 0, unexplained: 0 };
  // Receipts after QuickBooks' last deposit out of Undeposited Funds first (those before it were most likely in it), then
  // all of them: the ones adding up to exactly what's still there are the ones waiting. No exact set → unexplained.
  const { rows: [last] } = await tx.query(`SELECT max(p.txn_date)::text AS d FROM posting p JOIN txn t ON t.txn_id = p.txn_id
      WHERE p.org_id = $1 AND p.account_id = $2 AND p.amount_cents < 0 AND t.type NOT IN ('payment', 'sales_receipt')`, [orgId, sys.undeposited]);
  const { rows } = await tx.query(`SELECT txn_id, txn_date::text AS d, total_cents FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = ANY($3::bigint[])
      AND type IN ('payment', 'sales_receipt') AND coalesce(account_id, $4) = $4 ORDER BY txn_date DESC, txn_id DESC`, [orgId, entityId, ids, sys.undeposited]);
  let exhausted = false;
  for (const pool of [rows.filter(r => !last.d || r.d >= last.d), rows]) {
    const pick = subsetSum(pool.map(r => Number(r.total_cents)), balance);
    if (pick?.exhausted) exhausted = true;
    if (!Array.isArray(pick)) continue;
    const waiting = pick.map(i => Number(pool[i].txn_id));
    await tx.query('UPDATE txn SET import_undeposited = true WHERE org_id = $1 AND txn_id = ANY($2::bigint[])', [orgId, waiting]);
    return { balance, waiting: waiting.length, unexplained: 0, chosenByAmount: true };
  }
  return { balance, waiting: 0, unexplained: balance, searchGaveUp: exhausted };
}

// "123 Main St, Lubbock, TX 79401" → { line1, city, state, postal }; anything else → { line1: the text }.
function address(text) {
  const t = String(text ?? '').replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const m = /^(.*?),?\s+([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:,?\s*(?:US|USA|United States))?$/.exec(t);
  return m ? { line1: m[1].replace(/,\s*$/, ''), city: m[2].trim(), state: m[3], postal: m[4] } : { line1: t.slice(0, 200) };
}
const contactNote = c => [c.fullName && c.fullName !== c.name ? `Full name: ${c.fullName}` : null].filter(Boolean).join('\n') || null;

const firstEmail = e => (e ? String(e).split(/[,;\s]+/).find(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)) ?? null : null);
function net(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) m.set(Number(k), (m.get(Number(k)) ?? 0) + v);
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}
// Does the plan post exactly the Journal's amounts to exactly the Journal's accounts?
function samePostings(plan, journalNet, sys) {
  let postings;
  try {
    postings = postingsFor({ txn: { txn_id: 0, type: plan.type, total_cents: plan.total, account_id: plan.accountId ?? null, to_account_id: plan.toAccountId ?? null,
      customer_id: plan.customerId ?? null, vendor_id: plan.vendorId ?? null, cash_back_cents: plan.cashBack ?? 0, cash_back_account_id: plan.cashBackAccountId ?? null },
    lines: (plan.lines ?? []).map((l, i) => ({ line_no: i + 1, account_id: l.accountId, amount_cents: l.amount, customer_id: l.customerId ?? null, vendor_id: l.vendorId ?? null })),
    depositLines: (plan.depositLines ?? []).map((d, i) => ({ line_no: i + 1, account_id: d.accountId, amount_cents: d.amount, customer_id: d.customerId ?? null })), sys });
  } catch {
    return false;
  }
  // Reference completeness requires the header total to cover every debit.
  // Shapes such as cash-back deposits or mixed-sign category lines keep their
  // exact Journal lines through the existing journal-entry fallback instead.
  if (postings.reduce((sum,p)=>sum+Math.max(0,p.amountCents),0) !== plan.total) return false;
  const ours = net(postings.map(p => [p.accountId, p.amountCents]));
  if (ours.size !== journalNet.size) return false;
  for (const [k, v] of journalNet) if (ours.get(k) !== v) return false;
  return true;
}

// The native form of a QuickBooks transaction, or null when it doesn't fit one.
async function nativePlan({ q, lines, name, partyFor, customers, vendors, sys }) {
  const money = lines.filter(l => MONEY_TYPES.has(l.accountType));
  const isCustomerName = n => n && customers.has(n) && !vendors.has(n);
  const lineCustomer = l => (l.name && customers.has(l.name) && l.name !== name ? customers.get(l.name) : null);
  if (q.type === 'Check' || q.type === 'Expense' || q.type === 'Credit Card Expense') {
    // Paid from one bank or card account; everything else is what it paid for.
    // (A card payment written as a check has the card account as its "category".)
    const paying = money.filter(l => l.amount < 0);
    if (paying.length !== 1 || lines.length < 2) return null;
    const pay = paying[0];
    // A check or expense is paid to a vendor here; a customer payee is kept by name.
    const party = isCustomerName(name) ? {} : await partyFor(name, false);
    const isCheck = q.type === 'Check' && pay.accountType === 'bank';
    return { type: isCheck ? 'check' : 'expense', total: -pay.amount, accountId: pay.accountId, vendorId: party.vendorId ?? null,
      paymentMethod: isCheck ? 'Check' : null, memoExtra: isCustomerName(name) ? `Paid to ${name}` : null,
      lines: lines.filter(l => l !== pay).map(l => ({ accountId: l.accountId, amount: l.amount, description: l.memo ?? null, customerId: lineCustomer(l) })) };
  }
  if (q.type === 'Credit Card Credit') {
    // A card refund, the mirror of a card expense: back onto one card account; everything else is what was refunded.
    // A line on A/R or A/P stays a journal entry (its open item is matched there). So does money from a customer: a card
    // credit has no customer, and the journal keeps the customer on its lines (as the bank review does).
    const card = money.filter(l => l.amount > 0);
    if (card.length !== 1 || card[0].accountType !== 'credit_card' || lines.length < 2) return null;
    if (lines.some(l => [sys.ar, sys.ap].map(Number).includes(Number(l.accountId)))) return null;
    if (isCustomerName(name)) return null;
    const party = await partyFor(name, false);
    return { type: 'cc_credit', total: card[0].amount, accountId: card[0].accountId, vendorId: party.vendorId ?? null,
      lines: lines.filter(l => l !== card[0]).map(l => ({ accountId: l.accountId, amount: -l.amount, description: l.memo ?? null, customerId: lineCustomer(l) })) };
  }
  if (q.type === 'Deposit') {
    const into = lines.filter(l => l.accountType === 'bank' && l.amount > 0);
    if (into.length !== 1) return null;
    const rest = lines.filter(l => l !== into[0]);
    const credits = rest.filter(l => l.amount < 0), debits = rest.filter(l => l.amount > 0);
    if (!credits.length || debits.length > 1) return null;
    // Like the deposit form: other funds can't come from Undeposited Funds, A/R or A/P (payments aren't linked here).
    if (credits.some(l => [sys.undeposited, sys.ar, sys.ap].map(Number).includes(l.accountId))) return null;
    const depositLines = [];
    for (const l of credits) {
      // Received from: the line's name, else the deposit's. A vendor (a refund, say) is kept by name in the description.
      const from = l.name ?? name;
      const p = from ? await partyFor(from, true) : {};
      depositLines.push({ accountId: l.accountId, amount: -l.amount, customerId: p.customerId ?? null,
        description: [p.vendorId ? `From ${from}` : null, l.memo].filter(Boolean).join(' · ') || null });
    }
    return { type: 'deposit', total: into[0].amount, accountId: into[0].accountId, depositLines,
      ...(debits.length ? { cashBack: debits[0].amount, cashBackAccountId: debits[0].accountId } : {}) };
  }
  const ar = l => Number(l.accountId) === Number(sys.ar), ap = l => Number(l.accountId) === Number(sys.ap);
  const isCogsPair = l => ['cost_of_goods_sold', 'inventory'].includes(l.accountType) || (l.accountType === 'other_current_asset' && /inventory/i.test(l.account));
  if (q.type === 'Invoice' || q.type === 'Credit Memo') {
    const sign = q.type === 'Invoice' ? 1 : -1;
    const arLines = lines.filter(ar);
    if (arLines.length !== 1 || sign * arLines[0].amount <= 0 || !name) return null;
    const party = await partyFor(name, true);
    if (!party.customerId) return null;
    const companion = lines.filter(l => !ar(l) && isCogsPair(l));
    const sales = lines.filter(l => !ar(l) && !companion.includes(l));
    if (!sales.length) return null;
    return { type: q.type === 'Invoice' ? 'invoice' : 'credit_memo', total: sign * arLines[0].amount, customerId: party.customerId,
      lines: sales.map(l => ({ accountId: l.accountId, amount: -sign * l.amount, description: l.memo ?? null })), companion };
  }
  if (q.type === 'Sales Receipt') {
    const into = lines.filter(l => l.amount > 0 && (MONEY_TYPES.has(l.accountType) || Number(l.accountId) === Number(sys.undeposited)));
    if (into.length !== 1 || !name) return null;
    const party = await partyFor(name, true);
    if (!party.customerId) return null;
    const companion = lines.filter(l => l !== into[0] && isCogsPair(l));
    const sales = lines.filter(l => l !== into[0] && !companion.includes(l));
    if (!sales.length) return null;
    return { type: 'sales_receipt', total: into[0].amount, accountId: into[0].accountId, customerId: party.customerId,
      lines: sales.map(l => ({ accountId: l.accountId, amount: -l.amount, description: l.memo ?? null })), companion };
  }
  if (q.type === 'Payment') {
    // Deposited to Undeposited Funds or straight to a bank account.
    const arLines = lines.filter(ar), into = lines.filter(l => !ar(l));
    if (lines.length !== 2 || arLines.length !== 1 || arLines[0].amount >= 0 || !name) return null;
    const toUndeposited = Number(into[0].accountId) === Number(sys.undeposited);
    if (!toUndeposited && into[0].accountType !== 'bank') return null;
    const party = await partyFor(name, true);
    if (!party.customerId) return null;
    return { type: 'payment', total: -arLines[0].amount, customerId: party.customerId, accountId: toUndeposited ? null : into[0].accountId };
  }
  if (q.type === 'Bill' || q.type === 'Vendor Credit') {
    const sign = q.type === 'Bill' ? -1 : 1;
    const apLines = lines.filter(ap);
    if (apLines.length !== 1 || sign * apLines[0].amount <= 0 || !name) return null;
    const party = await partyFor(name, false);
    if (!party.vendorId) return null;
    const rest = lines.filter(l => !ap(l));
    if (!rest.length) return null;
    return { type: q.type === 'Bill' ? 'bill' : 'vendor_credit', total: sign * apLines[0].amount, vendorId: party.vendorId,
      lines: rest.map(l => ({ accountId: l.accountId, amount: -sign * l.amount, description: l.memo ?? null, customerId: lineCustomer(l) })) };
  }
  if (/^Bill Payment/.test(q.type)) {
    const apLines = lines.filter(ap), paid = lines.filter(l => MONEY_TYPES.has(l.accountType));
    if (lines.length !== 2 || apLines.length !== 1 || paid.length !== 1 || apLines[0].amount <= 0 || !name) return null;
    const party = await partyFor(name, false);
    if (!party.vendorId) return null;
    return { type: 'bill_payment', total: apLines[0].amount, accountId: paid[0].accountId, vendorId: party.vendorId,
      paymentMethod: /Check/.test(q.type) && paid[0].accountType === 'bank' ? 'Check' : null };
  }
  if (q.type === 'Transfer' || q.type === 'Credit Card Payment') {
    if (lines.length !== 2) return null;
    const to = lines.find(l => l.amount > 0), from = lines.find(l => l.amount < 0);
    if (!to || !from || to.accountId === from.accountId) return null;
    return { type: q.type === 'Transfer' ? 'transfer' : 'cc_payment', total: to.amount, accountId: from.accountId, toAccountId: to.accountId,
      memoExtra: name ? `With ${name}` : null };
  }
  return null;
}

// QuickBooks' lines as they are, as a journal entry (names on the lines).
async function journalPlan({ q, lines, partyFor }) {
  const out = [];
  for (const l of lines) {
    const n = l.name ?? q.name;
    const p = n ? await partyFor(n, ['Invoice', 'Payment', 'Sales Receipt', 'Credit Memo', 'Refund'].includes(q.type)) : {};
    out.push({ accountId: l.accountId, amount: l.amount, description: l.memo ?? null, customerId: p.customerId ?? null, vendorId: p.customerId ? null : p.vendorId ?? null });
  }
  return { type: 'journal_entry', total: out.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0), lines: out };
}
