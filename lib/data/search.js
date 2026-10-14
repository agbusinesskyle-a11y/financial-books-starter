import { TYPE_LABELS } from '../domain/status.js';
import { linkOf } from '../views/accounts.js';
import { REPORTS, ALIASES } from '../reports/registry.js';
import { GROUPS, REPORTS_MENU, GEAR } from '../views/nav.js';

// Global search (stage N2): customers, vendors, transactions, products, accounts, reports and menu pages.
// can(path) is the signed-in person's access check; results they couldn't open are left out.
const like = q => `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;

export async function globalSearch(db, { orgId, entityId, q, can, limit = 8 }) {
  const text = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!text) return { q: '', sections: [] };
  const pat = like(text);
  // "1,234.50" or "$1234.5" also finds transactions of that amount.
  const cents = /^\$?\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text.replace(/[$,]/g, '')) * 100) : null;
  // Only a plausible amount (a long reference or card number is searched as text only).
  const amount = Number.isSafeInteger(cents) && cents <= 99_999_999_99 ? cents : null;
  const [customers, vendors, txns, items, accounts] = await Promise.all([
    db.query(`SELECT customer_id AS id, display_name AS name, company_name, email, phone, active FROM customer
       WHERE org_id = $1 AND entity_id = $2 AND (display_name ILIKE $3 OR company_name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3)
       ORDER BY active DESC, lower(display_name) LIMIT $4`, [orgId, entityId, pat, limit]),
    db.query(`SELECT vendor_id AS id, display_name AS name, company_name, email, phone, active FROM vendor
       WHERE org_id = $1 AND entity_id = $2 AND (display_name ILIKE $3 OR company_name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3)
       ORDER BY active DESC, lower(display_name) LIMIT $4`, [orgId, entityId, pat, limit]),
    db.query(`SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.memo, t.txn_date::text AS date, t.total_cents, t.voided_at IS NOT NULL AS voided,
            coalesce(c.display_name, v.display_name) AS party
       FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2
        AND (t.doc_number ILIKE $3 OR t.payment_ref ILIKE $3 OR t.memo ILIKE $3 OR ($5::bigint IS NOT NULL AND abs(t.total_cents) = $5))
      ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT $4`, [orgId, entityId, pat, limit * 3, amount]),
    db.query(`SELECT item_id AS id, name, description FROM item WHERE org_id = $1 AND entity_id = $2 AND (name ILIKE $3 OR description ILIKE $3)
       ORDER BY lower(name) LIMIT $4`, [orgId, entityId, pat, limit]),
    db.query(`SELECT account_id AS id, name, number FROM account WHERE org_id = $1 AND entity_id = $2 AND (name ILIKE $3 OR number ILIKE $3)
       ORDER BY number NULLS LAST, lower(name) LIMIT $4`, [orgId, entityId, pat, limit]),
  ]);
  const lower = text.toLowerCase();
  const has = s => String(s ?? '').toLowerCase().includes(lower);
  const ok = href => can(href.split('?')[0]);
  const sections = [
    ['Customers', customers.rows.map(r => ({ href: `/customers/${r.id}`, label: r.name, detail: [r.company_name !== r.name ? r.company_name : '', r.email, r.active ? '' : 'Inactive'].filter(Boolean).join(' · ') }))],
    ['Vendors', vendors.rows.map(r => ({ href: `/vendors/${r.id}`, label: r.name, detail: [r.company_name !== r.name ? r.company_name : '', r.email, r.active ? '' : 'Inactive'].filter(Boolean).join(' · ') }))],
    ['Transactions', txns.rows.map(r => ({ href: linkOf(r), label: `${TYPE_LABELS[r.type] ?? r.type} ${r.doc_number ?? r.payment_ref ?? ''}`.trim(),
      detail: [r.date, r.party, `$${(Math.abs(Number(r.total_cents)) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, r.memo, r.voided ? 'Voided' : ''].filter(Boolean).join(' · ') }))],
    ['Products and services', items.rows.map(r => ({ href: `/settings/items/${r.id}`, label: r.name, detail: r.description ?? '' }))],
    ['Accounts', accounts.rows.map(r => ({ href: `/settings/accounts/${r.id}`, label: [r.number, r.name].filter(Boolean).join(' '), detail: '' }))],
    ['Reports', REPORTS.filter(r => has(r.title) || has(ALIASES[r.key])).slice(0, limit).map(r => ({ href: `/reports/r/${r.key}`, label: r.title, detail: r.about ?? '' }))],
    ['Pages', [...GROUPS.flatMap(g => g.items.map(i => ({ ...i, group: g.label }))), ...REPORTS_MENU.map(i => ({ ...i, group: 'Reports' })),
      ...GEAR.flatMap(([h, items]) => items.map(i => ({ ...i, group: h })))]
      .filter(i => has(i.label) || has(i.group))
      .map(i => ({ href: i.href ?? `/soon/${i.slug}`, label: i.label, detail: i.href ? i.group : `${i.group} · Soon` }))
      .filter((i, n, all) => all.findIndex(x => x.href === i.href) === n).slice(0, limit)],
  ].map(([title, rows]) => [title, rows.filter(r => ok(r.href)).slice(0, limit)]).filter(([, rows]) => rows.length);
  return { q: text, sections };
}
