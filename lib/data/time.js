import { withTransaction } from '../db.js';
import { ValidationError } from './writes.js';
import { isIsoDate, addDays } from '../domain/dates.js';
import { centsToInput } from '../domain/money.js';

// Time tracking: entries by person and day, optionally for a customer / project and service, billable or not.
// Everyone can keep their own time; admins and standard users see and change everyone's.

const fail = message => { throw new ValidationError(message); };
const seesAll = who => who.role === 'admin' || who.role === 'standard';
const mine = who => (who.userId ? { sql: 'e.user_id = $X', value: who.userId } : { sql: 'e.user_id IS NULL AND e.person = $X', value: who.name });

// Monday of the week a date falls in.
export function weekStart(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

// "1.5", "1:30", "90m" -> minutes; null if it isn't a time.
export function parseHours(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,4})\s*m(in)?$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,2}(?:\.\d{1,2})?)\s*h?$/.exec(s);
  if (m) return Math.round(Number(m[1]) * 60);
  return null;
}
export const hoursText = minutes => (minutes % 60 ? (minutes / 60).toFixed(2).replace(/0$/, '') : String(minutes / 60));

const ENTRY_SQL = `SELECT e.*, c.display_name AS customer_name, p.name AS project_name, i.name AS item_name, i.rate_cents,
    (SELECT l.txn_id FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE l.time_entry_id = e.entry_id AND t.voided_at IS NULL LIMIT 1) AS billed_txn_id
  FROM time_entry e LEFT JOIN customer c ON c.customer_id = e.customer_id LEFT JOIN project p ON p.project_id = e.project_id LEFT JOIN item i ON i.item_id = e.item_id`;

export async function listEntries(db, { orgId, entityId, who, from, to, everyone = false }) {
  const params = [orgId, entityId, from, to];
  let filter = '';
  if (!everyone || !seesAll(who)) { const m = mine(who); params.push(m.value); filter = `AND ${m.sql.replace('$X', `$${params.length}`)}`; }
  const { rows } = await db.query(`${ENTRY_SQL} WHERE e.org_id = $1 AND e.entity_id = $2 AND e.entry_date BETWEEN $3 AND $4 ${filter}
    ORDER BY e.entry_date, e.entry_id`, params);
  return rows;
}

export async function getEntry(db, { orgId, entityId, entryId }) {
  const { rows: [e] } = await db.query(`${ENTRY_SQL} WHERE e.org_id = $1 AND e.entity_id = $2 AND e.entry_id = $3`, [orgId, entityId, entryId]);
  return e ?? null;
}

const canChange = (who, e) => seesAll(who) || (who.userId ? e.user_id === who.userId : e.user_id === null && e.person === who.name);

// The customer / project and service for an entry. job: 'c:ID' | 'p:ID' | ''.
async function resolve(tx, { orgId, entityId }, { job, itemId }) {
  let customerId = null, projectId = null;
  const m = /^([cp]):(\d{1,18})$/.exec(String(job ?? ''));
  if (m?.[1] === 'p') {
    const { rows: [p] } = await tx.query(`SELECT p.project_id, p.customer_id FROM project p JOIN customer c ON c.customer_id = p.customer_id
                                            WHERE p.org_id = $1 AND c.entity_id = $2 AND p.project_id = $3`, [orgId, entityId, Number(m[2])]);
    if (!p) fail('Choose a valid project.');
    ({ project_id: projectId, customer_id: customerId } = p);
  } else if (m?.[1] === 'c') {
    if (!(await tx.query('SELECT 1 FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, Number(m[2])])).rowCount) fail('Choose a valid customer.');
    customerId = Number(m[2]);
  }
  const item = /^\d{1,18}$/.test(String(itemId ?? '')) ? Number(itemId) : null;
  if (item && !(await tx.query(`SELECT 1 FROM item WHERE org_id = $1 AND entity_id = $2 AND item_id = $3 AND kind IN ('service', 'product')`, [orgId, entityId, item])).rowCount) {
    fail('Choose a service from the list.');
  }
  return { customerId, projectId, itemId: item };
}

// fields: { date, job, itemId, hours, billable, notes }. Returns the entry id.
export async function saveEntry(pool, { orgId, entityId, entryId = null, who, fields: f }) {
  if (!isIsoDate(f.date)) fail('Enter the date.');
  const minutes = parseHours(f.hours);
  if (!minutes || minutes > 1440) fail('Enter the time worked, like 1.5 or 1:30.');
  return withTransaction(pool, async tx => {
    const ref = await resolve(tx, { orgId, entityId }, f);
    const billable = f.billable === true || f.billable === '1';
    if (billable && !ref.customerId) fail('Choose the customer to bill, or untick Billable.');
    const notes = String(f.notes ?? '').trim().slice(0, 500) || null;
    if (entryId) {
      const e = await getEntry(tx, { orgId, entityId, entryId }) ?? fail('Time entry not found.');
      if (!canChange(who, e)) fail('You can only change your own time.');
      if (e.billed_txn_id) fail('This time is on an invoice. Remove it from the invoice first.');
      await tx.query(`UPDATE time_entry SET entry_date = $3, customer_id = $4, project_id = $5, item_id = $6, minutes = $7, billable = $8, notes = $9
                       WHERE org_id = $1 AND entry_id = $2`, [orgId, entryId, f.date, ref.customerId, ref.projectId, ref.itemId, minutes, billable, notes]);
      return entryId;
    }
    const { rows: [r] } = await tx.query(
      `INSERT INTO time_entry (org_id, entity_id, user_id, person, entry_date, customer_id, project_id, item_id, minutes, billable, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING entry_id`,
      [orgId, entityId, who.userId ?? null, who.name, f.date, ref.customerId, ref.projectId, ref.itemId, minutes, billable, notes]);
    return r.entry_id;
  });
}

export async function deleteEntry(pool, { orgId, entityId, entryId, who }) {
  return withTransaction(pool, async tx => {
    const e = await getEntry(tx, { orgId, entityId, entryId }) ?? fail('Time entry not found.');
    if (!canChange(who, e)) fail('You can only delete your own time.');
    if (e.billed_txn_id) fail('This time is on an invoice. Remove it from the invoice first.');
    await tx.query('DELETE FROM time_entry WHERE entry_id = $1', [entryId]);
  });
}

// The weekly timesheet: rows [{ job, itemId, billable, hours: [7 texts, Monday first] }]. Only the cells whose total changed are
// rewritten: an unchanged day keeps its entries as they are (notes, several entries on one day); a changed day's unbilled
// entries are replaced by one entry with the new total (keeping the first entry's notes). Billed time is never touched.
export async function saveWeek(pool, { orgId, entityId, who, monday, rows }) {
  if (!isIsoDate(monday) || weekStart(monday) !== monday) fail('Choose a week.');
  return withTransaction(pool, async tx => {
    const wanted = new Map(); // "job|item|billable|day" -> { ref, billable, date, minutes }
    for (const [i, r] of rows.entries()) {
      const hours = r.hours.map(h => String(h ?? '').trim());
      if (!hours.some(Boolean)) continue;
      const ref = await resolve(tx, { orgId, entityId }, r);
      const billable = r.billable === true || r.billable === '1';
      if (billable && !ref.customerId) fail(`Row ${i + 1}: choose the customer to bill, or make it not billable.`);
      hours.forEach((h, d) => {
        if (!h) return;
        const minutes = parseHours(h);
        if (!minutes || minutes > 1440) fail(`Row ${i + 1}: “${h}” isn’t a time like 1.5 or 1:30.`);
        const key = `${ref.projectId ? `p:${ref.projectId}` : ref.customerId ? `c:${ref.customerId}` : ''}|${ref.itemId ?? ''}|${billable}|${d}`;
        const cell = wanted.get(key) ?? { ref, billable, date: addDays(monday, d), minutes: 0 };
        cell.minutes += minutes;
        if (cell.minutes > 1440) fail(`Row ${i + 1}: more than 24 hours on one day.`);
        wanted.set(key, cell);
      });
    }
    const m = mine(who);
    const { rows: have } = await tx.query(
      `SELECT e.* FROM time_entry e WHERE e.org_id = $1 AND e.entity_id = $2 AND e.entry_date BETWEEN $3 AND $4 AND ${m.sql.replace('$X', '$5')}
          AND NOT EXISTS (SELECT 1 FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE l.time_entry_id = e.entry_id AND t.voided_at IS NULL)
        ORDER BY e.entry_id`, [orgId, entityId, monday, addDays(monday, 6), m.value]);
    const existing = new Map();
    for (const e of have) {
      const d = Math.round((Date.parse(`${e.entry_date}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000);
      const key = `${e.project_id ? `p:${e.project_id}` : e.customer_id ? `c:${e.customer_id}` : ''}|${e.item_id ?? ''}|${e.billable}|${d}`;
      const g = existing.get(key) ?? { entries: [], minutes: 0 };
      g.entries.push(e);
      g.minutes += e.minutes;
      existing.set(key, g);
    }
    let changed = 0;
    for (const key of new Set([...wanted.keys(), ...existing.keys()])) {
      const want = wanted.get(key), had = existing.get(key);
      if ((want?.minutes ?? 0) === (had?.minutes ?? 0)) continue;
      if (had) await tx.query('DELETE FROM time_entry WHERE entry_id = ANY($1::bigint[])', [had.entries.map(e => e.entry_id)]);
      if (want) {
        await tx.query(
          `INSERT INTO time_entry (org_id, entity_id, user_id, person, entry_date, customer_id, project_id, item_id, minutes, billable, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [orgId, entityId, who.userId ?? null, who.name, want.date, want.ref.customerId, want.ref.projectId,
            want.ref.itemId, want.minutes, want.billable, had?.entries.find(e => e.notes)?.notes ?? null]);
      }
      changed++;
    }
    return changed;
  });
}

// Billable time for a customer that no live invoice bills yet.
export async function unbilledTime(db, { orgId, entityId, customerId }) {
  const { rows } = await db.query(`${ENTRY_SQL} WHERE e.org_id = $1 AND e.entity_id = $2 AND e.customer_id = $3 AND e.billable
      AND NOT EXISTS (SELECT 1 FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE l.time_entry_id = e.entry_id AND t.voided_at IS NULL)
    ORDER BY e.entry_date, e.entry_id`, [orgId, entityId, customerId]);
  return rows;
}

// Invoice editor lines for billable time: hours × the service's rate.
export const timeLines = entries => entries.map(e => ({
  itemId: e.item_id ? String(e.item_id) : '', description: `${e.item_name ?? 'Time'} — ${e.person}${e.notes ? `: ${e.notes}` : ''}`.slice(0, 500),
  quantity: hoursText(e.minutes), rate: e.rate_cents ? centsToInput(e.rate_cents) : '', serviceDate: e.entry_date, estimateLine: '', billable: '', timeEntry: String(e.entry_id),
}));
