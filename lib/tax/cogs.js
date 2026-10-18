// lib/tax/cogs.js
// The cost of goods sold workpaper (spec §4.10, §5.5 inventory class): one per (return, activity), the COGS workpaper provider of Form
// 1125-A's lines for that activity. The person states the inventory TREATMENT apart from the VALUATION:
//   treatment   inventory_as_booked — purchases, labor, section 263A and other costs counted when incurred, as the books record them (an
//               accrual method's inventory, or a cash method's books-and-records inventory method: one rule for every input, so a
//               part-paid or unpaid cost is in when booked and never again when paid); materials_and_supplies (deducted when paid or
//               used) and other — no rule here reconstructs them: the reviewed path, typed from its source;
//   valuation   cost or lower of cost or market, and the Form 1125-A line 9 flags as answered (LIFO, a write-down of subnormal goods, a
//               change in determining quantities, cost or valuations) — an "other" method or any flag is the reviewed path only.
// Two paths:
//   reconstruct  (inventory_as_booked, plain valuation) purchases, labor, section 263A and other costs come from the cogs_input routings
//                (T2): an income-statement account's activity as booked (less an accrual excluded by its review on an accrual return,
//                lib/tax/cash.js accrualTiming); an inventory (balance) account's period postings classified by movement type — purchase
//                and return count as purchases; transfer, adjustment, shrinkage and the cost of sales do not (shrinkage and adjustments
//                reach COGS through the counted ending inventory). Each posting line is classified by its transaction type unless a person
//                classified it; a journal entry is never guessed, and a person's class whose transaction changed since is never replaced
//                by the default: the line is unresolved until classified again. A saved class no measured line matches any more (the
//                line renumbered, moved to another account, redated out of the period, deleted or voided) stays listed and holds the
//                workpaper lines it could reach unknown — the line its account feeds, and that of any line of its transaction now — until
//                it is cleared (Codex t3-plan-r4 R4-3). Tax beginning and ending inventory are entered here,
//                held apart from book Schedule L.
//   reviewed     lines 1-5 and 7 typed, with their source named.
// Book COGS (cogs_tieout) is shown beside line 8 and is never purchases. Exact BigInt cents.
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { parseCentsBig } from './partition.js';
import { measureLines } from './measure.js';
import { openTaxReturn, idOf, personOf, MAX_STATEMENT_ROWS } from './open-return.js';
import { effectiveIn } from './destinations.js';
import { semanticOf } from './engine/formulas.js';
import { catalogFor } from './catalog/index.js';

const fail = message => { throw new ValidationError(message); };
export const MOVEMENT_CLASSES = [['purchase', 'Purchase'], ['return', 'Return to vendor'], ['transfer', 'Transfer between inventory accounts'], ['adjustment', 'Count adjustment'],
  ['shrinkage', 'Shrinkage'], ['cost_of_sales', 'Cost of goods sold (relief)']];
export const TREATMENTS = [['inventory_as_booked', 'Inventory: costs counted when incurred, as the books record them'], ['materials_and_supplies', 'Non-incidental materials and supplies (deducted when paid or used)'],
  ['other', 'Another inventory treatment (explain in the note)']];
export const METHODS = [['cost', 'Cost'], ['lower_of_cost_or_market', 'Lower of cost or market'], ['other', 'Other (explain in the note)']];
const PURCHASE_TYPES = ['bill', 'item_receipt', 'expense', 'check', 'cc_credit'];
// The class a transaction type gives an inventory posting line by default; null for a journal entry or anything else a person decides.
export function defaultMovement(type, cents) {
  if (PURCHASE_TYPES.includes(type)) return cents >= 0n ? 'purchase' : 'return';
  if (type === 'vendor_credit') return 'return';
  if (type === 'inventory_adjustment') return cents < 0n ? 'shrinkage' : 'adjustment';
  if (['invoice', 'sales_receipt', 'credit_memo'].includes(type)) return 'cost_of_sales';
  if (type === 'transfer') return 'transfer';
  return null;
}
const LINES = ['1', '2', '3', '4', '5', '7'];
const slotOf = (n, activityId) => `f1125a.main.${n}|activity=act:${activityId}|activity`;

export async function listWorkpapers(db, { orgId, returnId }) {
  const { rows } = await db.query(`SELECT w.workpaper_id, w.activity_id, w.path, w.treatment, w.method, w.lifo, w.subnormal_writedown, w.valuation_changed, w.begin_cents::text AS begin_cents,
      w.end_cents::text AS end_cents, w.reviewed_lines, w.source_note, w.reviewed_by, a.name AS activity_name FROM tax_cogs_workpaper w JOIN tax_activity a ON a.org_id = w.org_id AND a.activity_id = w.activity_id
     WHERE w.org_id = $1 AND w.return_id = $2 ORDER BY w.activity_id`, [orgId, returnId]);
  return rows.map(w => ({ ...w, workpaper_id: Number(w.workpaper_id), activity_id: Number(w.activity_id) }));
}

// The workpaper results of a return. routed: lib/tax/coverage.js routeAllocations(cov). exclusions: Map `${slotKey}|${accountId}` → { cents
// (ledger), stale, reason } — what an accrual return's timing reviews take out of a COGS input (compute.js). → Map activityId → { activityId,
// name, workpaper, values: { '1'..'7': cents | rows | null }, reasons, inputs, tieout: { cents, members, known }, movements, candidates }
export async function cogsResults(db, { orgId, ret, cov, routed, exclusions = new Map() }) {
  const catalog = catalogFor(ret.return_type, Number(ret.form_edition));
  const papers = await listWorkpapers(db, { orgId, returnId: ret.return_id });
  const out = new Map();
  const entry = (activityId, name) => {
    if (!out.has(activityId)) out.set(activityId, { activityId, name, workpaper: null, values: {}, reasons: [], inputs: [], tieout: { cents: 0n, members: [], known: true }, movements: [], candidates: [] });
    return out.get(activityId);
  };
  const activityNames = new Map((await db.query('SELECT activity_id, name FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2', [orgId, ret.entity_id])).rows.map(a => [Number(a.activity_id), a.name]));
  for (const w of papers) entry(w.activity_id, w.activity_name).workpaper = w;
  for (const r of routed) {
    if (r.treatment === 'cogs_tieout') {
      const id = r.member.activityId;
      if (id === null) continue;
      const e = entry(id, activityNames.get(id) ?? `Activity ${id}`);
      e.tieout.members.push(r.member);
      if (r.member.cents === null || !r.complete) e.tieout.known = false; else e.tieout.cents += r.member.cents;
    } else if (r.provider === 'cogs_workpaper' && r.role === 'input') {
      const m = /^f1125a\.main\.(\d)\|activity=act:(\d+)\|activity$/.exec(r.key);
      if (!m) continue;
      entry(Number(m[2]), activityNames.get(Number(m[2])) ?? `Activity ${m[2]}`).inputs.push({ line: m[1], route: r });
    }
  }
  // Every saved class, with whether its posting line is still one of the period (present) — read whatever the workpaper can measure.
  const { rows: overrides } = await db.query(`SELECT m.movement_id, m.account_id, m.txn_id, m.line_no, m.class, m.txn_version, txn_version(m.txn_id) AS current_version, m.reviewed_by, m.affected_domains, m.reason,
      a.name AS account_name, EXISTS (SELECT 1 FROM posting p WHERE p.org_id = m.org_id AND p.account_id = m.account_id AND p.txn_id = m.txn_id AND p.line_no = m.line_no
        AND p.txn_date BETWEEN $3::date AND $4::date) AS present
     FROM tax_cogs_movement m LEFT JOIN account a ON a.org_id = m.org_id AND a.account_id = m.account_id WHERE m.org_id = $1 AND m.return_id = $2 ORDER BY m.movement_id`, [orgId, ret.return_id, ret.period_start, ret.period_end]);
  const matched = new Set(); // overrides a measured line matched
  const overrideOf = (a, t, l) => { const o = overrides.find(x => Number(x.account_id) === a && Number(x.txn_id) === t && Number(x.line_no) === l) ?? null; if (o) matched.add(o.movement_id); return o; };
  const savedOf = o => (o ? { movementId: Number(o.movement_id), accountId: Number(o.account_id), txnId: Number(o.txn_id), lineNo: Number(o.line_no), class: o.class, txnVersion: o.txn_version,
    domains: o.affected_domains, reason: o.reason, by: o.reviewed_by } : null);
  for (const e of out.values()) {
    const w = e.workpaper;
    if (!w) { for (const n of LINES) e.values[n] = null; e.reasons.push(`${e.name} has cost of goods sold routed to it: start its COGS workpaper.`); continue; }
    if (w.path === 'reviewed') {
      for (const n of LINES) {
        const v = w.reviewed_lines?.[n];
        e.values[n] = n === '5' ? (Array.isArray(v) ? v.map(x => ({ label: String(x.label), cents: BigInt(x.cents) })) : null) : v === undefined || v === null ? null : BigInt(v);
        if (e.values[n] === null) e.reasons.push(`Line ${n} of the reviewed COGS workpaper is not entered.`);
      }
      continue;
    }
    // Reconstruct (inventory_as_booked with a plain valuation: migration 066 holds it to that).
    e.values['1'] = w.begin_cents === null ? null : BigInt(w.begin_cents);
    e.values['7'] = w.end_cents === null ? null : BigInt(w.end_cents);
    if (e.values['1'] === null) e.reasons.push('Enter the tax beginning inventory.');
    if (e.values['7'] === null) e.reasons.push('Enter the tax ending inventory (from the count, at the method shown).');
    const sums = { '2': 0n, '3': 0n, '4': 0n }, rows5 = new Map();
    const known = { '2': true, '3': true, '4': true, '5': true };
    const excludedOnce = new Set(); // an exclusion is the slot's and account's: taken once, however many allocations (a line and the rest) feed it
    for (const { line, route } of e.inputs) {
      const src = cov.sources.find(s => s.entityId === route.member.sourceEntityId);
      const acct = src?.accounts?.find(a => a.accountId === route.member.accountId);
      const l = catalog.byId.get(`f1125a.main.${line}`);
      if (!route.complete || route.member.cents === null || !acct) { known[line] = false; e.reasons.push(`An input to line ${line} is not completely mapped.`); continue; }
      let cents;
      if (acct.pl) {
        // An income-statement cost as booked, less what an accrual return's timing review excluded from it (never twice: the excluded part
        // is the review's M-1 difference through this workpaper, not an adjustment of its own).
        const k = `${route.key}|${acct.accountId}`, x = exclusions.get(k);
        if (x?.stale) { known[line] = false; e.reasons.push(x.reason); continue; }
        const take = x && !excludedOnce.has(k) ? x.cents : 0n;
        excludedOnce.add(k);
        cents = semanticOf(l, route.member.cents - take);
      } else {
        // An inventory (balance) account: its classified purchase movements, never its whole activity.
        if (acct.attributions.length || acct.bindings.filter(b => b.measurement === 'activity').length !== 1) { known[line] = false; e.reasons.push(`${acct.name} feeds the workpaper from a split or line-attributed activity: route its whole activity to one COGS line.`); continue; }
        const lines = (await measureLines(db, { orgId, sourceEntityId: acct.entityId, accountIds: [acct.accountId], periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id })).get(acct.accountId) ?? [];
        cents = 0n;
        for (const ln of lines) {
          const o = ln.lineNo === null ? null : overrideOf(acct.accountId, ln.txnId, ln.lineNo);
          const stale = Boolean(o && o.txn_version !== o.current_version);
          const cls = stale ? null : o ? o.class : defaultMovement(ln.type, ln.cents);
          e.movements.push({ accountId: acct.accountId, accountName: acct.name, txnId: ln.txnId, lineNo: ln.lineNo, date: ln.date, type: ln.type, docNumber: ln.docNumber, cents: ln.cents, txnVersion: ln.txnVersion,
            cls, overridden: Boolean(o), stale, was: stale ? o.class : null, gone: false, line, saved: savedOf(o) });
          if (stale) { known[line] = false; e.reasons.push(`The ${ln.type.replace('_', ' ')} ${ln.docNumber || ln.txnId} on ${acct.name} changed after it was classified as ${o.class}: classify it again.`); continue; }
          if (cls === null) { known[line] = false; e.reasons.push(`Classify the ${ln.type.replace('_', ' ')} ${ln.docNumber || ln.txnId} on ${acct.name}: is it a purchase, a transfer, an adjustment?`); continue; }
          if (cls === 'purchase' || cls === 'return') cents += ln.cents;
        }
      }
      if (line === '5') rows5.set(acct.name, (rows5.get(acct.name) ?? 0n) + cents);
      else sums[line] += cents;
    }
    for (const n of ['2', '3', '4']) e.values[n] = known[n] ? sums[n] : null;
    e.values['5'] = known['5'] ? [...rows5].map(([label, cents]) => ({ label, cents })) : null;
  }
  // Saved classes reconciled by their SAVED identity, whatever the workpaper could measure (Codex t3-plan-r5 R5-4; t3-plan-r6 R6-2, R6-4):
  // every class that is stale or that no measured line matches is checked against its transaction's postings of the period as they are NOW,
  // and holds every reconstructed workpaper input those postings' accounts feed — an inventory account's or an income-statement cost's
  // cogs_input route alike — so a replacement line never takes the default. Where the saved account's own cost goes now decides the rest:
  //   a reconstructed workpaper        → its line is held (the current-line loop already did when the line still matches);
  //   a reviewed workpaper, or only a   → the class is not needed by the current path: kept and listed with Clear, holding nothing — a known
  //     comparison (book COGS by line 8)  reviewed amount or an unrelated reconstruction is never invalidated by it;
  //   no route at all                  → the destination cannot be determined: every reconstructed workpaper's cost lines are held.
  // Every saved class is also frozen whole (classes).
  const built = [...out.values()].filter(e => e.workpaper?.path === 'reconstruct');
  const pending = overrides.filter(o => !matched.has(o.movement_id) || o.txn_version !== o.current_version);
  const { rows: nowRows } = pending.length ? await db.query(`SELECT p.txn_id, p.account_id FROM posting p WHERE p.org_id = $1 AND p.txn_id = ANY($2::bigint[]) AND p.txn_date BETWEEN $3::date AND $4::date`,
    [orgId, [...new Set(pending.map(o => Number(o.txn_id)))], ret.period_start, ret.period_end]) : { rows: [] };
  const routesOf = acc => routed.filter(r => r.member.accountId === acc && r.member.measurement === 'activity' && r.member.kind !== 'unread');
  const inputsOf = ids => [...out.values()].flatMap(e => e.inputs.filter(({ route }) => ids.includes(route.member.accountId)).map(({ line }) => [e, line]));
  const isBuilt = ([e]) => e.workpaper?.path === 'reconstruct';
  for (const o of pending) {
    const acc = Number(o.account_id), tid = Number(o.txn_id), isMatched = matched.has(o.movement_id);
    const where = `transaction ${tid}, line ${o.line_no} on ${o.account_name ?? `account ${acc}`}`;
    const replacements = [...new Set(nowRows.filter(r => Number(r.txn_id) === tid).map(r => Number(r.account_id)))].filter(id => id !== acc);
    const stale = o.txn_version !== o.current_version;
    const ownInputs = inputsOf([acc]), ownBuilt = ownInputs.filter(isBuilt);
    // Two separate questions (Codex t3-plan-r7 R7-1): does the OLD destination still read this class (a reconstructed workpaper: yes; a
    // reviewed one or a comparison-only route: no — its entered amount does not depend on it), and does the CHANGED transaction now reach
    // reconstructed inputs through other accounts (a replacement line: held, whatever the old destination needs). Replacements are looked
    // for only when the saved line is gone or its transaction changed — an unchanged, present class nobody reads holds nothing.
    const notNeeded = !ownBuilt.length && (ownInputs.length > 0 || routesOf(acc).some(r => r.role === 'comparison'));
    const replBuilt = !o.present || stale ? inputsOf(replacements).filter(isBuilt) : [];
    if (isMatched && !replBuilt.length) continue; // a stale line the current-line loop already holds, its transaction reaching nothing else
    let targets = [...(isMatched || notNeeded ? [] : ownBuilt), ...replBuilt];
    if (!targets.length && !notNeeded && !isMatched && !ownInputs.length && !routesOf(acc).length) targets = built.flatMap(e => ['2', '3', '4', '5'].map(n => [e, n]));
    for (const [e, n] of targets) e.values[n] = null;
    const why = isMatched ? `The ${where} changed after it was classified as ${o.class}; the lines its transaction posts to now wait too.`
      : !o.present ? `A movement classified as ${o.class} (${where}) no longer matches a posting of this period: clear the class, then classify the posting as it is now.`
        : notNeeded ? null
          : `A movement classified as ${o.class} (${where}) cannot be checked: its account's input is not completely mapped; map it, or clear the class.`;
    const shownOn = new Set([...targets.map(([e]) => e), ...ownInputs.map(([e]) => e)]);
    if (!shownOn.size) for (const e of built) shownOn.add(e); // nowhere of its own to show it: every reconstructed workpaper lists it
    for (const e of shownOn) {
      if (why && !e.reasons.includes(why)) e.reasons.push(why);
      if (!isMatched) e.movements.push({ accountId: acc, accountName: o.account_name, txnId: tid, lineNo: Number(o.line_no), date: null, type: null, docNumber: null, cents: null, txnVersion: o.current_version ?? null,
        cls: null, overridden: true, stale: !notNeeded, was: o.class, gone: true, present: o.present, notNeeded, line: null, saved: savedOf(o) });
    }
  }
  out.classes = overrides.map(o => ({ ...savedOf(o), present: o.present, matched: matched.has(o.movement_id), stale: o.txn_version !== o.current_version }));
  return out;
}
export const cogsSlots = (activityId) => Object.fromEntries(LINES.map(n => [n, slotOf(n, activityId)]));

// Save one activity's workpaper. treatment and method as above; lifo, subnormalWritedown, valuationChanged: the Form 1125-A line 9 answers
// (booleans). reviewedLines (reviewed path): { '1': '1250.00', ..., '5': [{ label, amount }], '7': '...' } as typed, with sourceNote naming
// their source.
export async function saveWorkpaper(pool, { orgId, entityId, returnId, activityId, path, treatment = null, method, lifo = false, subnormalWritedown = false, valuationChanged = false,
  begin = null, end = null, reviewedLines = null, sourceNote = null, reviewedBy }) {
  if (!['reconstruct', 'reviewed'].includes(path)) fail('Choose how the cost of goods sold is worked out.');
  if (!TREATMENTS.some(([x]) => x === treatment)) fail('Choose the inventory treatment.');
  if (!METHODS.some(([m]) => m === method)) fail('Choose the inventory method.');
  if (![lifo, subnormalWritedown, valuationChanged].every(x => typeof x === 'boolean')) fail('Answer the valuation questions (LIFO, a write-down of subnormal goods, a change in valuation).');
  const note = String(sourceNote ?? '').trim().slice(0, 1000);
  if (path === 'reconstruct') {
    if (treatment !== 'inventory_as_booked') fail('Only inventory counted as the books record it is reconstructed here: for materials and supplies, or another treatment, type the reviewed lines with their source.');
    if (method === 'other' || lifo || subnormalWritedown || valuationChanged) fail('LIFO, a write-down of subnormal goods, a change in valuation or another method is not reconstructed in this stage: type the reviewed lines with their source.');
  } else if (!note) fail('Name the source of the reviewed lines (the workpaper, the count, the return they come from).');
  if ((treatment === 'other' || method === 'other') && !note) fail('Explain the inventory treatment or method in the note.');
  const who = personOf(reviewedBy);
  const cents = (v, what) => { if (v === null || v === undefined || v === '') return null; const c = parseCentsBig(v); if (c === null) fail(`${what}: enter an amount like 1250.00.`); return c; };
  let lines = null, b = null, e = null;
  if (path === 'reviewed') {
    lines = {};
    for (const n of ['1', '2', '3', '4', '7']) { const c = cents(reviewedLines?.[n], `Line ${n}`); if (c === null) fail(`Line ${n}: enter the reviewed amount (0.00 when there is none).`); lines[n] = c.toString(); }
    const rows = (reviewedLines?.['5'] ?? []).filter(x => String(x?.label ?? '').trim() || String(x?.amount ?? '').trim());
    if (rows.length > MAX_STATEMENT_ROWS) fail(`Other costs hold at most ${MAX_STATEMENT_ROWS} rows; this workpaper has ${rows.length}.`);
    lines['5'] = rows.map((x, i) => { const c = cents(x.amount, `Other cost ${i + 1}`); if (c === null || !String(x.label ?? '').trim()) fail(`Other cost ${i + 1}: give it a name and an amount.`); return { label: String(x.label).trim().slice(0, 200), cents: c.toString() }; });
    if (new Set(lines['5'].map(x => x.label)).size !== lines['5'].length) fail('Each other cost has its own name.');
  } else { b = cents(begin, 'Beginning inventory'); e = cents(end, 'Ending inventory'); }
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const aid = idOf(activityId, 'The activity');
    const { rows: [a] } = await tx.query(`SELECT activity_id, name, effective_from::text AS effective_from, effective_to::text AS effective_to, disposed_on::text AS disposed_on FROM tax_activity
       WHERE org_id = $1 AND activity_id = $2 AND return_entity_id = $3`, [orgId, aid, ret.entity_id]);
    if (!a) fail('Activity not found on this return.');
    if (!effectiveIn(a, ret)) fail(`${a.name} is not in effect in this period.`);
    await tx.query(`INSERT INTO tax_cogs_workpaper (org_id, return_id, activity_id, path, treatment, method, lifo, subnormal_writedown, valuation_changed, begin_cents, end_cents, reviewed_lines, source_note, reviewed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (org_id, return_id, activity_id) DO UPDATE SET path = EXCLUDED.path, treatment = EXCLUDED.treatment, method = EXCLUDED.method,
      lifo = EXCLUDED.lifo, subnormal_writedown = EXCLUDED.subnormal_writedown, valuation_changed = EXCLUDED.valuation_changed, begin_cents = EXCLUDED.begin_cents, end_cents = EXCLUDED.end_cents,
      reviewed_lines = EXCLUDED.reviewed_lines, source_note = EXCLUDED.source_note, reviewed_by = EXCLUDED.reviewed_by, updated_at = now()`,
    [orgId, ret.return_id, aid, path, treatment, method, lifo, subnormalWritedown, valuationChanged, b === null ? null : b.toString(), e === null ? null : e.toString(), lines ? JSON.stringify(lines) : null, note || null, who]);
  });
}
// Clear a person's class for one inventory-account posting line (the only way to release a class that no longer matches a posting).
export async function clearMovement(pool, { orgId, entityId, returnId, accountId, txnId, lineNo }) {
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const { rowCount } = await tx.query('DELETE FROM tax_cogs_movement WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND txn_id = $4 AND line_no = $5',
      [orgId, ret.return_id, idOf(accountId, 'The account'), idOf(txnId, 'The transaction'), idOf(lineNo, 'The line')]);
    if (!rowCount) fail('That class is not on this period.');
  });
}
// A person's class for one inventory-account posting line, tied to its transaction version.
// reason: undefined keeps the stored note (a form that does not carry the field); '' clears it; text replaces it.
export async function classifyMovement(pool, { orgId, entityId, returnId, accountId, txnId, lineNo, cls, expectTxnVersion, reviewedBy, reason }) {
  if (!MOVEMENT_CLASSES.some(([c]) => c === cls)) fail('Choose what this movement is.');
  const who = personOf(reviewedBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const acc = idOf(accountId, 'The account'), tid = idOf(txnId, 'The transaction'), ln = idOf(lineNo, 'The line');
    const { rows: [p] } = await tx.query(`SELECT txn_version(p.txn_id) AS v FROM posting p WHERE p.org_id = $1 AND p.entity_id = $2 AND p.account_id = $3 AND p.txn_id = $4 AND p.line_no = $5
       AND p.txn_date BETWEEN $6::date AND $7::date LIMIT 1`, [orgId, ret.entity_id, acc, tid, ln, ret.period_start, ret.period_end]);
    if (!p) fail('That line does not post to this account in the period.');
    if (!expectTxnVersion || expectTxnVersion !== p.v) fail('This transaction changed since the page was shown. Look at it again.');
    // Saved with its identity: the return, the account, transaction and line, its domain (cost of goods sold: income) and the reason.
    const given = reason !== undefined, note = given ? String(reason ?? '').trim().slice(0, 500) || null : null;
    await tx.query(`INSERT INTO tax_cogs_movement (org_id, return_id, account_id, txn_id, line_no, class, txn_version, reviewed_by, affected_domains, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (org_id, return_id, account_id, txn_id, line_no) DO UPDATE SET class = EXCLUDED.class, txn_version = EXCLUDED.txn_version, reviewed_by = EXCLUDED.reviewed_by,
      affected_domains = EXCLUDED.affected_domains, reason = CASE WHEN $11 THEN EXCLUDED.reason ELSE tax_cogs_movement.reason END`,
    [orgId, ret.return_id, acc, tid, ln, cls, p.v, who, ['income'], note, given]);
  });
}
