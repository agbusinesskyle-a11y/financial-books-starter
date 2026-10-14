import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from './writes.js';
import { repost, systemAccounts } from './ledger.js';
import { isIsoDate, addDays } from '../domain/dates.js';
import { CURRENCIES, HOME, toHome, parseRate } from '../domain/fx.js';
import { formatCents } from '../domain/money.js';

// Settings → Currencies: multicurrency on (for good), the currencies in use, exchange rates by date, and revaluation.

const fail = message => { throw new ValidationError(message); };

export async function multicurrencyOn(db, { orgId, entityId }) {
  return (await db.query('SELECT 1 FROM currency_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rowCount > 0;
}

export async function turnOnMulticurrency(pool, { orgId, entityId, actor }) {
  await pool.query('INSERT INTO currency_settings (org_id, entity_id, turned_on_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [orgId, entityId, actor]);
}

export async function listCurrencies(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT c.code, c.name, r.rate::float8 AS rate, r.rate_date,
            (SELECT count(*)::int FROM customer x WHERE x.org_id = c.org_id AND x.entity_id = c.entity_id AND x.currency = c.code)
          + (SELECT count(*)::int FROM vendor x WHERE x.org_id = c.org_id AND x.entity_id = c.entity_id AND x.currency = c.code) AS used_by
       FROM currency c LEFT JOIN LATERAL (SELECT rate, rate_date FROM exchange_rate e WHERE e.org_id = c.org_id AND e.entity_id = c.entity_id AND e.code = c.code
                                          ORDER BY rate_date DESC LIMIT 1) r ON true
      WHERE c.org_id = $1 AND c.entity_id = $2 ORDER BY c.code`, [orgId, entityId]);
  return rows;
}

export async function addCurrency(pool, { orgId, entityId, code, rateText, date }) {
  if (!(await multicurrencyOn(pool, { orgId, entityId }))) fail('Turn on multicurrency first.');
  const c = CURRENCIES.find(([k]) => k === code) ?? fail('Choose a currency.');
  const rate = parseRate(rateText) ?? fail(`Enter how many ${HOME} one ${code} is worth, like 1.0834.`);
  await withTransaction(pool, async tx => {
    await tx.query('INSERT INTO currency (org_id, entity_id, code, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [orgId, entityId, c[0], c[1]]);
    await setRate(tx, { orgId, entityId, code, rate, date });
  });
}

async function setRate(db, { orgId, entityId, code, rate, date }) {
  if (!isIsoDate(date)) fail('Enter the date the rate is for.');
  await db.query(`INSERT INTO exchange_rate (org_id, entity_id, code, rate_date, rate) VALUES ($1,$2,$3,$4,$5)
                  ON CONFLICT (org_id, entity_id, code, rate_date) DO UPDATE SET rate = EXCLUDED.rate`, [orgId, entityId, code, date, rate]);
}

export async function addRate(pool, { orgId, entityId, code, rateText, date }) {
  if (!(await pool.query('SELECT 1 FROM currency WHERE org_id = $1 AND entity_id = $2 AND code = $3', [orgId, entityId, code])).rowCount) fail('Add the currency first.');
  const rate = parseRate(rateText) ?? fail('Enter the rate as a number, like 1.0834.');
  await setRate(pool, { orgId, entityId, code, rate, date });
}

export async function listRates(db, { orgId, entityId, code }) {
  return (await db.query('SELECT rate_date, rate::float8 AS rate FROM exchange_rate WHERE org_id = $1 AND entity_id = $2 AND code = $3 ORDER BY rate_date DESC LIMIT 60',
    [orgId, entityId, code])).rows;
}

// The rate in force on a date (the latest on or before it), or null.
export async function rateOn(db, { orgId, entityId, code, date }) {
  if (!isIsoDate(date)) return null;
  const { rows: [r] } = await db.query(
    'SELECT rate::float8 AS rate FROM exchange_rate WHERE org_id = $1 AND entity_id = $2 AND code = $3 AND rate_date <= $4 ORDER BY rate_date DESC LIMIT 1',
    [orgId, entityId, code, date]);
  return r?.rate ?? null;
}

// Rate for a new foreign transaction: what was typed, else the rate on its date.
export async function resolveRate(db, { orgId, entityId, code, date, typed }) {
  if (String(typed ?? '').trim()) return parseRate(typed) ?? fail('The exchange rate is a number like 1.0834.');
  return (await rateOn(db, { orgId, entityId, code, date })) ?? fail(`There’s no ${code} exchange rate for ${date}. Add one in Settings → Currencies, or type the rate.`);
}

// A foreign payment or credit after its applications change: what it took off A/R or A/P (home, at the charges' rates) plus
// what's left of it at its own rate; reposted so the difference lands in Exchange Gain or Loss.
export async function revalueCredit(tx, { orgId, txnId }) {
  const { rows: [t] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND txn_id = $2 FOR UPDATE', [orgId, txnId]);
  if (!t?.currency || t.voided_at) return;
  const { rows: [a] } = await tx.query(
    `SELECT coalesce(sum(amount_cents), 0)::bigint AS home, coalesce(sum(foreign_cents), 0)::bigint AS foreign FROM application WHERE credit_txn_id = $1`, [txnId]);
  const foreignOpen = Number(t.foreign_total_cents) - Number(a.foreign);
  const open = t.type === 'bill_payment' ? 0 : toHome(foreignOpen, t.exchange_rate);
  await tx.query('UPDATE txn SET foreign_open_cents = $3, open_cents = $4, total_cents = $5, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
    [orgId, txnId, t.type === 'bill_payment' ? 0 : foreignOpen, open, Number(a.home) + open]);
  await repost(tx, orgId, txnId, { replay: false });
}

// Unrealized gain or loss: open foreign invoices, bills and credits valued at the rate on `date`, against what they're carried
// at. Posts one revaluation entry dated `date` (to A/R, A/P and Unrealized Gain or Loss) and its reversal the next day.
export async function revalue(pool, { orgId, entityId, date, actor }) {
  if (!isIsoDate(date)) fail('Choose the date to revalue at (usually the last day of a month).');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    if ((await tx.query(`SELECT 1 FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'fx_revaluation' AND txn_date = $3 AND reverses_txn_id IS NULL`,
      [orgId, entityId, date])).rowCount) fail(`Open balances were already revalued at ${date}.`);
    // Balances are today's, so the date can't be before foreign activity that already changed them.
    const { rows: [last] } = await tx.query(
      `SELECT max(d)::text AS d FROM (SELECT max(txn_date) AS d FROM txn WHERE org_id = $1 AND entity_id = $2 AND currency IS NOT NULL
         UNION ALL SELECT max(a.applied_on) FROM application a JOIN txn t ON t.txn_id = a.charge_txn_id WHERE t.org_id = $1 AND t.entity_id = $2 AND t.currency IS NOT NULL) x`,
      [orgId, entityId]);
    if (last.d && date < last.d) fail(`Revalue at ${last.d} or later: foreign transactions on that date already changed the open balances.`);
    const sys = await systemAccounts(tx, orgId, entityId);
    const { rows } = await tx.query(
      `SELECT type, currency, foreign_open_cents, open_cents FROM txn
        WHERE org_id = $1 AND entity_id = $2 AND currency IS NOT NULL AND voided_at IS NULL AND foreign_open_cents <> 0 AND txn_date <= $3
          AND type IN ('invoice', 'payment', 'credit_memo', 'bill', 'vendor_credit')`, [orgId, entityId, date]);
    let ar = 0, ap = 0;
    const missing = new Set();
    for (const r of rows) {
      const rate = await rateOn(tx, { orgId, entityId, code: r.currency, date });
      if (!rate) { missing.add(r.currency); continue; }
      const now = toHome(r.foreign_open_cents, rate), carried = Number(r.open_cents);
      // Charges are debits on A/R (invoices) or credits on A/P (bills); credits the other way.
      if (r.type === 'invoice') ar += now - carried;
      else if (r.type === 'payment' || r.type === 'credit_memo') ar -= now - carried;
      else if (r.type === 'bill') ap -= now - carried;
      else ap += now - carried;
    }
    if (missing.size) fail(`Add ${[...missing].join(', ')} rates for ${date} (or earlier) first.`);
    if (!ar && !ap) return { arCents: 0, apCents: 0, txnId: null };
    const lines = [[sys.ar, ar], [sys.ap, ap], [sys.fx_unrealized, -(ar + ap)]].filter(([, a]) => a);
    const make = async (on, sign, memo, reverses = null) => {
      const debits = lines.filter(([, a]) => a * sign > 0).reduce((s, [, a]) => s + a * sign, 0);
      const { rows: [t] } = await tx.query(
        `INSERT INTO txn (org_id, entity_id, type, txn_date, memo, total_cents, open_cents, reverses_txn_id) VALUES ($1,$2,'fx_revaluation',$3,$4,$5,0,$6) RETURNING txn_id`,
        [orgId, entityId, on, memo, debits, reverses]);
      for (const [i, [accountId, amount]] of lines.entries()) {
        await tx.query('INSERT INTO txn_line (org_id, txn_id, line_no, account_id, quantity, rate_cents, amount_cents) VALUES ($1,$2,$3,$4,1,$5,$6)',
          [orgId, t.txn_id, i + 1, accountId, Math.abs(amount), amount * sign]);
      }
      await repost(tx, orgId, t.txn_id, { replay: false });
      return t.txn_id;
    };
    const txnId = await make(date, 1, `Revaluation of open foreign balances at ${date} (by ${actor})`);
    await make(addDays(date, 1), -1, `Reverses the ${date} revaluation`, txnId);
    return { arCents: ar, apCents: ap, txnId, summary: `A/R ${formatCents(ar)}, A/P ${formatCents(ap)}` };
  });
}

// A customer's or vendor's currency: set before their first transaction, fixed after. code '' = home currency.
export async function setPartyCurrency(tx, { orgId, entityId, table, id, code }) {
  if (!['customer', 'vendor'].includes(table)) throw new Error('bad table');
  const next = String(code ?? '').trim() || null;
  const { rows: [p] } = await tx.query(`SELECT currency, display_name FROM ${table} WHERE org_id = $1 AND entity_id = $2 AND ${table}_id = $3`, [orgId, entityId, id]);
  if (!p || (p.currency ?? null) === next) return;
  if (next && !(await tx.query('SELECT 1 FROM currency WHERE org_id = $1 AND entity_id = $2 AND code = $3', [orgId, entityId, next])).rowCount) {
    fail('Choose a currency from Settings → Currencies.');
  }
  if ((await tx.query(`SELECT 1 FROM txn WHERE org_id = $1 AND ${table}_id = $2 LIMIT 1`, [orgId, id])).rowCount) {
    fail(`${p.display_name} already has transactions in ${p.currency ?? HOME}, so the currency can’t change.`);
  }
  await tx.query(`UPDATE ${table} SET currency = $3 WHERE org_id = $1 AND ${table}_id = $2`, [orgId, id, next]);
}

// For forms: the currencies to offer (empty when multicurrency is off) and whether this party's currency is fixed.
export async function partyCurrencyChoices(db, { orgId, entityId, table, id = null }) {
  if (!(await multicurrencyOn(db, { orgId, entityId }))) return { currencies: [], locked: false };
  const currencies = (await db.query('SELECT code, name FROM currency WHERE org_id = $1 AND entity_id = $2 ORDER BY code', [orgId, entityId])).rows;
  const locked = id ? (await db.query(`SELECT 1 FROM txn WHERE org_id = $1 AND ${table === 'vendor' ? 'vendor_id' : 'customer_id'} = $2 LIMIT 1`, [orgId, id])).rowCount > 0 : false;
  return { currencies, locked };
}
