import { classPath } from './keys.js';

// Exhaustive column classification from migrations 001, 007, 009-011, 014-017,
// 019-021, 023, 044-046, 048-049. The schema regression requires every column to
// remain classified. Foreign keys become natural identities, never numeric ids.
export const identityColumns = {
  txn: {
    values: `type doc_number txn_date due_date memo payment_method payment_ref total_cents open_cents
      voided_at approval_status rejected_reason system_kind closed_at scheduled_pay_date scheduled_method
      discount_percent discount_cents shipping_cents estimate_status fee_cents surcharge_cents currency
      exchange_rate foreign_total_cents foreign_open_cents foreign_discount_cents foreign_shipping_cents
      is_adjusting email_cc email_bcc bill_to ship_to ship_via ship_date tracking_no po_number internal_note
      statement_memo print_later send_later accepted_by accepted_date deposit_request_percent cash_back_cents
      cash_back_memo import_undeposited`.split(/\s+/),
    refs: { customer_id:'customer', vendor_id:'vendor', project_id:'project', account_id:'account',
      recurring_template_id:'recurring_template', source_txn_id:'txn', scheduled_account_id:'account',
      terms_id:'terms', deposit_for_txn_id:'txn', class_id:'class', location_id:'location',
      to_account_id:'account', reverses_txn_id:'txn', cash_back_account_id:'account', companion_of_txn_id:'txn' },
    // Provenance and actor/time audit metadata do not change accounting identity.
    ignored: 'org_id entity_id txn_id created_at updated_at approved_by approved_at printed_at scheduled_by source source_type'.split(' '),
  },
  txn_line: {
    values: `line_no description quantity rate_cents amount_cents cost_cents qty_change received_qty received_cents
      po_line_no service_date estimate_line_no billable billable_line_no foreign_amount_cents foreign_rate_cents kind`.split(/\s+/),
    refs: { item_id:'item', account_id:'account', customer_id:'customer', project_id:'project', po_txn_id:'txn',
      estimate_txn_id:'txn', class_id:'class', billable_txn_id:'txn', vendor_id:'vendor', time_entry_id:'time_entry' },
    ignored: ['org_id','txn_id'],
  },
  posting: {
    values: ['line_no','amount_cents','txn_date','memo'],
    refs: { account_id:'account', customer_id:'customer', project_id:'project', item_id:'item', vendor_id:'vendor', class_id:'class', location_id:'location' },
    ignored: ['org_id','entity_id','posting_id','txn_id'],
  },
  deposit_line: {
    values: ['line_no','description','amount_cents'],
    refs: { source_txn_id:'txn', account_id:'account', customer_id:'customer', class_id:'class' },
    ignored: ['org_id','deposit_txn_id'],
  },
  application: {
    values: ['amount_cents','applied_on','foreign_cents','credit_line_no','charge_line_no'],
    refs: { credit_txn_id:'txn', charge_txn_id:'txn', via_txn_id:'txn' },
    ignored: ['org_id','application_id','source'],
  },
  txn_tag: {
    values: [], refs: { tag_id:'tag' }, ignored: ['org_id','txn_id'],
  },
};
// These attached documents/workflows are not yet represented as portable content.
// Their presence prevents an equality claim; unknown future children do too.
export const unsupportedIdentityChildren = Object.fromEntries([
  'document','form_upload','invoice_pay_link','invoice_reminder','late_fee_charge',
  'message','online_checkout','receipt','recurring_run',
].map(table=>[table,'attached state requires a decision']));
export const ignoredIdentityChildren = {
  activity_event:'actor/time audit history',
  bank_feed_link:'feed links are carried separately by ll_transaction_id',
};
export const identityTables = ['account','customer','vendor','project','item','terms','class','location','recurring_template','time_entry','tag','tag_group',...Object.keys(identityColumns)];
export async function transactionChildren(db) {
  return (await db.query(`SELECT DISTINCT c.relname AS table_name, a.attname AS column_name
    FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid
    CROSS JOIN LATERAL unnest(f.conkey,f.confkey) k(child,parent)
    JOIN pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.child
    JOIN pg_attribute p ON p.attrelid=f.confrelid AND p.attnum=k.parent
    WHERE f.contype='f' AND f.confrelid='public.txn'::regclass AND f.conrelid<>f.confrelid
      AND p.attname='txn_id' ORDER BY 1,2`)).rows;
}
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const field = (table, col) => col === 'txn_date' ? 'date' : table === 'posting' && col === 'amount_cents' ? 'cents' : camel(col);
const json = value => JSON.parse(JSON.stringify(value));
const stable = value => JSON.stringify(value);

export function transactionKey(t, rows) {
  let representable = true;
  const scopes=new Map(), references=new Map();
  const scopeRows = table => {
    if (!scopes.has(table)) scopes.set(table,(rows[table] ?? []).filter(r => r.org_id === t.org_id
      && (r.entity_id === undefined || r.entity_id === t.entity_id)));
    return scopes.get(table);
  };
  const natural = (table, r) => {
    if (table === 'class') return classPath(new Map(scopeRows('class').map(c => [c.class_id,c])), r.class_id);
    if (table === 'txn') return { type:r.type, date:r.txn_date, docNumber:r.doc_number, totalCents:r.total_cents,
      customer:ref('customer',r.customer_id), vendor:ref('vendor',r.vendor_id) };
    if (table === 'project') return { name:r.name, customer:ref('customer',r.customer_id) };
    if (table === 'tag') return { name:r.name, group:ref('tag_group',r.group_id) };
    if (table === 'recurring_template') return { name:r.name, customer:ref('customer',r.customer_id), vendor:ref('vendor',r.vendor_id) };
    if (table === 'time_entry') return { person:r.person, date:r.entry_date, minutes:r.minutes, notes:r.notes,
      customer:ref('customer',r.customer_id), project:ref('project',r.project_id), item:ref('item',r.item_id) };
    return ['customer','vendor'].includes(table) ? r.display_name : r.name;
  };
  const ref = (table, id) => {
    if (id == null) return null;
    // Applications revisit the same party/document references many times. Cache
    // within this identity only; no mutable snapshot or later save shares a cache.
    const cacheKey=`${table}:${id}`;
    if (references.has(cacheKey)) return references.get(cacheKey);
    const idCol = table === 'recurring_template' ? 'template_id' : table === 'time_entry' ? 'entry_id' : table === 'tag_group' ? 'group_id' : `${table}_id`;
    const choices = scopeRows(table), row = choices.find(r => r[idCol] === id);
    if (!row) { representable = false; return { unresolved:table }; }
    const key = natural(table,row);
    if (choices.filter(r => stable(natural(table,r)) === stable(key)).length !== 1) representable = false;
    references.set(cacheKey,key);
    return key;
  };
  const key = (table, row) => {
    const spec = identityColumns[table];
    const known = new Set([...spec.values, ...Object.keys(spec.refs), ...spec.ignored]);
    if (Object.keys(row).some(col => !known.has(col))) representable = false;
    const out = {};
    for (const col of spec.values) {
      if (!Object.hasOwn(row,col)) representable = false;
      out[field(table,col)] = row[col];
    }
    for (const [col, target] of Object.entries(spec.refs)) {
      if (!Object.hasOwn(row,col)) representable = false;
      out[camel(col.replace(/_id$/, ''))] = ref(target,row[col]);
    }
    return out;
  };
  const out = key('txn',t);
  out.party = out.customer !== null ? {kind:'customer',name:out.customer} : out.vendor !== null ? {kind:'vendor',name:out.vendor} : null;
  out.lines = (rows.txn_line ?? []).filter(l => l.txn_id === t.txn_id).map(l => key('txn_line',l));
  out.depositLines = (rows.deposit_line ?? []).filter(l => l.deposit_txn_id === t.txn_id).map(l => key('deposit_line',l));
  out.applications = (rows.application ?? []).filter(a => [a.credit_txn_id,a.charge_txn_id,a.via_txn_id].includes(t.txn_id)).map(a => key('application',a));
  out.tags = (rows.txn_tag ?? []).filter(r => r.txn_id === t.txn_id).map(r => key('txn_tag',r));
  out.postings = (rows.posting ?? []).filter(p => p.txn_id === t.txn_id).map(p => ({...key('posting',p), dimensionsRepresentable:true}));
  out.unrepresentedChildren = [];
  for (const {table_name:table,column_name:column} of rows.transactionChildren ?? []) {
    if (identityColumns[table] || ignoredIdentityChildren[table]) continue;
    const count = (rows[table] ?? []).filter(r=>r[column]===t.txn_id).length;
    if (count) { representable=false; out.unrepresentedChildren.push({table,column,count}); }
  }
  out.identityRepresentable = representable;
  if (!representable) for (const p of out.postings) p.dimensionsRepresentable = false;
  return json(out);
}

// Child order is not accounting state; lineNo and every other child field are.
export function comparableTransaction(saved) {
  const { feedItems, ...key } = saved;
  const sort = rows => Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r))
    ? rows.map(r => Object.fromEntries(Object.entries(r).sort(([a],[b]) => a.localeCompare(b))))
      .sort((a,b) => stable(a).localeCompare(stable(b))) : null;
  return {...key, ...Object.fromEntries(['lines','depositLines','applications','tags','postings','unrepresentedChildren'].map(k=>[k,sort(key[k])]))};
}
