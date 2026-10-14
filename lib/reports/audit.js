import { TYPE_LABELS } from '../domain/status.js';
import { formatCents } from '../domain/money.js';
import { linkOf } from '../views/accounts.js';

// The audit log as a report: who changed what and when (migrations/024_audit_log.sql writes it).

export const AREAS = [
  ['', 'Everything'],
  ['transactions', 'Transactions', ['txn', 'application', 'txn_tag']],
  ['customers', 'Customers and projects', ['customer', 'project', 'statement']],
  ['vendors', 'Vendors', ['vendor', 'vendor_info_request']],
  ['products', 'Products and services', ['item', 'price_rule']],
  ['accounts', 'Accounts, budgets and reconciliations', ['account', 'budget', 'budget_line', 'reconciliation']],
  ['time', 'Time', ['time_entry']],
  ['settings', 'Settings', ['entity', 'accounting_settings', 'sales_settings', 'bill_settings', 'email_settings', 'payments_settings', 'currency_settings',
    'late_fee_policy', 'form_style', 'terms', 'class', 'location', 'tag', 'tag_group', 'currency', 'exchange_rate', 'recurring_template', 'report_note', 'document']],
  ['users', 'Users and invitations', ['app_user', 'user_invite']],
  ['reports', 'Saved reports, KPIs, management reports, cash plan', ['saved_report', 'kpi', 'mgmt_report', 'cash_plan_item', 'cash_plan_setting']],
  ['sign_ins', 'Sign-ins', ['session']],
];
const THING = {
  txn: 'Transaction', application: 'Payment applied', txn_tag: 'Tag on transaction', customer: 'Customer', project: 'Project', statement: 'Statement',
  vendor: 'Vendor', vendor_info_request: 'Vendor info request', item: 'Product/service', price_rule: 'Price rule', account: 'Account', budget: 'Budget',
  budget_line: 'Budget amount', reconciliation: 'Reconciliation', time_entry: 'Time entry', entity: 'Company settings', accounting_settings: 'Accounting settings',
  sales_settings: 'Sales settings', bill_settings: 'Bill settings', email_settings: 'Email settings', payments_settings: 'Payment settings',
  currency_settings: 'Currency settings', late_fee_policy: 'Late fee settings', form_style: 'Form style', terms: 'Terms', class: 'Class', location: 'Location',
  tag: 'Tag', tag_group: 'Tag group', currency: 'Currency', exchange_rate: 'Exchange rate', recurring_template: 'Recurring template', report_note: 'Report note',
  document: 'Document', saved_report: 'Custom report', kpi: 'KPI', mgmt_report: 'Management report', cash_plan_item: 'Cash plan item', cash_plan_setting: 'Cash plan threshold', app_user: 'User', user_invite: 'Invitation', session: 'Sign-in',
};
const VERB = { insert: 'Added', update: 'Changed', delete: 'Deleted', sign_in: 'Signed in', sign_in_failed: 'Sign-in failed' };
const HIDDEN = new Set(['org_id', 'entity_id']);

const pretty = (k, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (/_cents$/.test(k) && Number.isFinite(Number(v))) return formatCents(Number(v));
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
};
const label = k => k.replace(/_cents$/, '').replace(/_id$/, '').replace(/_/g, ' ');

function changes(r) {
  if (r.action === 'update') {
    return Object.keys(r.after ?? {}).filter(k => !HIDDEN.has(k)).slice(0, 8)
      .map(k => `${label(k)}: ${pretty(k, r.before?.[k])} → ${pretty(k, r.after[k])}`).join('; ');
  }
  const j = r.after ?? r.before ?? {};
  if (r.table_name === 'session') return [r.action === 'sign_in_failed' && j.email ? `as ${j.email}` : '', j.ip ? `from ${j.ip}` : ''].filter(Boolean).join(' ');
  if (r.table_name === 'txn') return [j.total_cents !== undefined ? `Total ${pretty('total_cents', j.total_cents)}` : '', j.txn_date ? `dated ${j.txn_date}` : ''].filter(Boolean).join(', ');
  if (r.table_name === 'application') return `${pretty('amount_cents', j.amount_cents)} applied`;
  return '';
}

// rows: audit_log rows with what each record is called now (or was called when deleted).
export async function auditReport(db, { orgId, entityId = null, from, to, timeZone, user = '', area = '', limit = 2000 }) {
  const tables = AREAS.find(a => a[0] === area)?.[2] ?? null;
  const { rows } = await db.query(
    `SELECT a.audit_id, a.at, (a.at AT TIME ZONE $5)::date::text AS day, to_char(a.at AT TIME ZONE $5, 'HH12:MI AM') AS time, a.actor, a.action, a.table_name, a.row_id,
            a.before, a.after,
            CASE a.table_name
              WHEN 'txn' THEN (SELECT t.type || '|' || coalesce(t.doc_number, t.payment_ref, '') FROM txn t WHERE t.txn_id = a.row_id)
              WHEN 'application' THEN NULL
              WHEN 'customer' THEN (SELECT display_name FROM customer WHERE customer_id = a.row_id)
              WHEN 'vendor' THEN (SELECT display_name FROM vendor WHERE vendor_id = a.row_id)
              WHEN 'item' THEN (SELECT name FROM item WHERE item_id = a.row_id)
              WHEN 'account' THEN (SELECT name FROM account WHERE account_id = a.row_id)
              WHEN 'project' THEN (SELECT name FROM project WHERE project_id = a.row_id)
              WHEN 'app_user' THEN (SELECT name FROM app_user WHERE user_id = a.row_id)
            END AS current_name
       FROM audit_log a
      WHERE a.org_id = $1 AND ($2::date IS NULL OR (a.at AT TIME ZONE $5)::date >= $2::date) AND (a.at AT TIME ZONE $5)::date <= $3::date
        AND ($4::text[] IS NULL OR a.table_name = ANY($4::text[])) AND ($6 = '' OR a.actor = $6)
        -- This company's changes, plus organization-wide ones (people, invitations, sign-ins). Older entries that couldn't be
        -- placed in a company show in none.
        AND ($7::bigint IS NULL OR a.entity_id = $7 OR (a.entity_id IS NULL AND a.table_name IN ('app_user', 'user_invite', 'session')))
      ORDER BY a.at DESC, a.audit_id DESC LIMIT ${limit + 1}`, [orgId, from, to, tables, timeZone || 'UTC', user, entityId]);
  const out = rows.slice(0, limit).map(r => {
    const j = r.after ?? r.before ?? {};
    let name = r.current_name ?? j.display_name ?? j.name ?? j.email ?? j.code ?? (j.report_key ? j.report_key.replace(/_/g, ' ') : '');
    let href = null;
    if (r.table_name === 'txn') {
      const [type, num] = (r.current_name ?? `${j.type ?? ''}|${j.doc_number ?? j.payment_ref ?? ''}`).split('|');
      name = `${TYPE_LABELS[type] ?? 'Transaction'} ${num}`.trim();
      if (r.action !== 'delete' && r.current_name) href = linkOf({ type, txn_id: r.row_id });
    }
    if (r.current_name && r.action !== 'delete') {
      href ??= { customer: `/customers/${r.row_id}`, vendor: `/vendors/${r.row_id}`, item: `/settings/items/${r.row_id}`, account: `/settings/accounts/${r.row_id}`,
        project: `/projects/${r.row_id}` }[r.table_name] ?? null;
    }
    return { kind: 'line', auditId: Number(r.audit_id), href, linkKey: 'record', cells: { date: r.day, time: r.time, user: r.actor,
      event: `${VERB[r.action] ?? r.action}${r.table_name === 'session' ? '' : ` ${THING[r.table_name] ?? r.table_name}`}`, record: name, changes: changes(r) } };
  });
  return { rows: out, truncated: rows.length > limit, columns: [{ key: 'date', label: 'Date' }, { key: 'time', label: 'Time' }, { key: 'user', label: 'User' },
    { key: 'event', label: 'Event' }, { key: 'record', label: 'Name' }, { key: 'changes', label: 'What changed' }] };
}

export async function auditUsers(db, { orgId }) {
  const { rows } = await db.query(`SELECT DISTINCT actor FROM audit_log WHERE org_id = $1 AND action <> 'sign_in_failed' ORDER BY actor LIMIT 500`, [orgId]);
  return rows.map(r => r.actor);
}
