import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, EMAIL } from './writes.js';
import { parseCsv, headerKey } from '../domain/csv.js';
import { parseMoney } from '../domain/money.js';
import { ACCOUNT_TYPES, RESERVED_TYPES } from '../domain/ledger.js';

// Tools → Import: customers, products and services, and the chart of accounts from CSV, each checked row by row
// before anything is saved. (Vendors have their own import on the Vendors page.)

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
const MAX_ROWS = 1000;

// The kinds: label, the columns (field -> header names it accepts), the required field, and check/insert.
export const IMPORTS = {
  customers: {
    label: 'Customers',
    headers: ['Name', 'Company', 'Email', 'Phone', 'Mobile', 'Street', 'City', 'State', 'ZIP', 'Terms', 'Note'],
    columns: { displayName: ['name', 'displayname', 'customer'], companyName: ['company', 'companyname'], email: ['email'], phone: ['phone'],
      mobile: ['mobile', 'cell'], line1: ['street', 'address', 'street1'], city: ['city'], state: ['state'], postal: ['zip', 'postal', 'postalcode', 'zipcode'],
      terms: ['terms'], note: ['note', 'notes'] },
    required: 'displayName',
    async context(db, { orgId, entityId }) {
      return {
        taken: new Set((await db.query('SELECT lower(display_name) AS n FROM customer WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows.map(r => r.n)),
        terms: new Map((await db.query('SELECT terms_id, name FROM terms WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows.map(t => [t.name.toLowerCase(), t.terms_id])),
      };
    },
    check(v, ctx) {
      if (v.displayName.length > 100) return 'Name is longer than 100 characters.';
      if (ctx.taken.has(v.displayName.toLowerCase())) return 'A customer with this name already exists.';
      if (v.email && !EMAIL.test(v.email)) return `“${v.email}” isn’t an email address.`;
      if (v.terms && !ctx.terms.has(v.terms.toLowerCase())) return `No terms called “${v.terms}”. Add them in Settings → Terms first.`;
      return null;
    },
    async insert(tx, { orgId, entityId, actor }, v, ctx) {
      const address = { line1: text(v.line1, 200), city: text(v.city, 100), state: text(v.state, 50), postal: text(v.postal, 20) };
      const { rows: [r] } = await tx.query(
        `INSERT INTO customer (org_id, entity_id, display_name, company_name, email, phone, mobile, billing_address, shipping_same_as_billing, terms_id, note_line)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10) RETURNING customer_id`,
        [orgId, entityId, v.displayName, text(v.companyName, 100), text(v.email, 200), text(v.phone, 40), text(v.mobile, 40),
          Object.values(address).some(Boolean) ? address : null, v.terms ? ctx.terms.get(v.terms.toLowerCase()) : null, text(v.note, 300)]);
      await logActivity(tx, { orgId, customerId: r.customer_id, actor, kind: 'customer_created', summary: `Customer ${v.displayName} imported` });
    },
    preview: v => [v.displayName, v.companyName, v.email, v.phone, v.city, v.terms],
    previewHeads: ['Name', 'Company', 'Email', 'Phone', 'City', 'Terms'],
  },

  items: {
    label: 'Products and services',
    headers: ['Name', 'Type', 'Description', 'Price', 'Cost', 'Income account', 'Expense account', 'SKU'],
    columns: { name: ['name', 'product', 'service', 'productservice', 'item'], kind: ['type', 'kind'], description: ['description', 'salesdescription'],
      price: ['price', 'rate', 'salesprice', 'salespricerate'], cost: ['cost', 'purchasecost'], income: ['incomeaccount', 'income'],
      expense: ['expenseaccount', 'expense'], sku: ['sku'] },
    required: 'name',
    async context(db, { orgId, entityId }) {
      const accounts = (await db.query('SELECT account_id, lower(name) AS n, type FROM account WHERE org_id = $1 AND entity_id = $2 AND active', [orgId, entityId])).rows;
      return {
        taken: new Set((await db.query('SELECT lower(name) AS n FROM item WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows.map(r => r.n)),
        skus: new Set((await db.query('SELECT lower(sku) AS s FROM item WHERE org_id = $1 AND entity_id = $2 AND sku IS NOT NULL', [orgId, entityId])).rows.map(r => r.s)),
        income: new Map(accounts.filter(a => ['income', 'other_income'].includes(a.type)).map(a => [a.n, a.account_id])),
        expense: new Map(accounts.filter(a => ['expense', 'other_expense', 'cost_of_goods_sold'].includes(a.type)).map(a => [a.n, a.account_id])),
      };
    },
    check(v, ctx, earlier) {
      if (v.name.length > 100) return 'Name is longer than 100 characters.';
      if (ctx.taken.has(v.name.toLowerCase())) return 'A product or service with this name already exists.';
      if (v.sku && (ctx.skus.has(v.sku.toLowerCase()) || earlier.some(e => e.sku?.toLowerCase() === v.sku.toLowerCase()))) return `SKU ${v.sku} is already used.`;
      const kind = (v.kind || 'service').toLowerCase();
      if (kind.startsWith('inv')) return 'Inventory items need an opening quantity; add them in Products and services one at a time.';
      if (!['service', 'product', 'noninventory', 'non-inventory', 'non inventory'].includes(kind)) return `Type “${v.kind}” should be Service or Product.`;
      if (v.price && parseMoney(v.price) === null) return `Price “${v.price}” isn’t an amount.`;
      if (v.cost && parseMoney(v.cost) === null) return `Cost “${v.cost}” isn’t an amount.`;
      if (v.income && !ctx.income.has(v.income.toLowerCase())) return `No income account called “${v.income}”.`;
      if (v.expense && !ctx.expense.has(v.expense.toLowerCase())) return `No expense account called “${v.expense}”.`;
      return null;
    },
    async insert(tx, { orgId, entityId }, v, ctx) {
      await tx.query(
        `INSERT INTO item (org_id, entity_id, name, description, kind, rate_cents, active, income_account_id, expense_account_id, purchase_cost_cents, sku)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10)`,
        [orgId, entityId, v.name, text(v.description, 500), (v.kind || 'service').toLowerCase() === 'service' ? 'service' : 'product', v.price ? parseMoney(v.price) : 0,
          v.income ? ctx.income.get(v.income.toLowerCase()) : null, v.expense ? ctx.expense.get(v.expense.toLowerCase()) : null, v.cost ? parseMoney(v.cost) : null,
          text(v.sku, 60)]);
    },
    preview: v => [v.name, v.kind || 'Service', v.price, v.income],
    previewHeads: ['Name', 'Type', 'Price', 'Income account'],
  },

  accounts: {
    label: 'Chart of accounts',
    headers: ['Name', 'Number', 'Type', 'Parent', 'Description'],
    columns: { name: ['name', 'account', 'accountname'], number: ['number', 'accountnumber', 'no'], type: ['type', 'accounttype'], parent: ['parent', 'subaccountof'],
      description: ['description'] },
    required: 'name',
    async context(db, { orgId, entityId }) {
      const rows = (await db.query('SELECT account_id, lower(name) AS n, number, type, parent_id FROM account WHERE org_id = $1 AND entity_id = $2', [orgId, entityId])).rows;
      return { byName: new Map(rows.map(a => [a.n, a])), numbers: new Set(rows.filter(a => a.number).map(a => a.number.toLowerCase())),
        types: new Map(ACCOUNT_TYPES.flatMap(([k, label]) => [[k, k], [label.toLowerCase(), k], [label.toLowerCase().replace(/\s*\(.*\)$/, ''), k]])) };
    },
    check(v, ctx, earlier) {
      if (v.name.length > 100) return 'Name is longer than 100 characters.';
      if (ctx.byName.has(v.name.toLowerCase())) return 'An account with this name already exists.';
      const type = ctx.types.get(String(v.type ?? '').trim().toLowerCase());
      if (!type) return `Type “${v.type}” isn’t one of: ${ACCOUNT_TYPES.filter(([k]) => !RESERVED_TYPES.has(k)).map(([, l]) => l).join(', ')}.`;
      if (RESERVED_TYPES.has(type)) return 'A/R and A/P accounts are built in; you can’t add another.';
      if (v.number && !/^[0-9A-Za-z.-]{1,20}$/.test(v.number)) return 'Numbers use digits, letters, dots and dashes.';
      if (v.number && (ctx.numbers.has(v.number.toLowerCase()) || earlier.some(e => e.number?.toLowerCase() === v.number.toLowerCase()))) return `Number ${v.number} is already used.`;
      if (v.parent) {
        const p = ctx.byName.get(v.parent.toLowerCase()) ?? earlier.find(e => e.name.toLowerCase() === v.parent.toLowerCase() && !e.parent && e.typeKey);
        if (!p) return `No account called “${v.parent}” to put it under.`;
        if (p.parent_id || p.parent) return 'Sub-accounts go one level deep.';
        // An existing account has its type key; a parent earlier in the same file has the key it was checked to.
        if ((p.account_id ? p.type : p.typeKey) !== type) return 'A sub-account must have the same type as its parent.';
      }
      v.typeKey = type;
      return null;
    },
    async insert(tx, { orgId, entityId }, v) {
      const parent = v.parent ? (await tx.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND lower(name) = lower($3)', [orgId, entityId, v.parent])).rows[0] : null;
      await tx.query('INSERT INTO account (org_id, entity_id, name, number, type, parent_id, description) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [orgId, entityId, v.name, text(v.number, 20), v.typeKey, parent?.account_id ?? null, text(v.description, 500)]);
    },
    preview: v => [v.name, v.number, v.type, v.parent],
    previewHeads: ['Name', 'Number', 'Type', 'Parent'],
  },
};

// Parses and checks a CSV without saving. Returns { rows: [{ line, values, error }], unknownHeaders }.
export async function previewImport(db, { orgId, entityId, kind, csv }) {
  const spec = IMPORTS[kind] ?? fail('Unknown import.');
  let table;
  try { table = parseCsv(csv); } catch (error) { fail(`That file isn’t valid CSV: ${error.message}`); }
  if (table.length < 2) fail('The file needs a header row and at least one row.');
  if (table.length > MAX_ROWS + 1) fail(`Import up to ${MAX_ROWS.toLocaleString('en-US')} rows at a time.`);
  const index = {}, unknownHeaders = [];
  table[0].map(headerKey).forEach((h, i) => {
    const field = Object.keys(spec.columns).find(k => spec.columns[k].includes(h));
    if (field && index[field] === undefined) index[field] = i; else if (!field && h) unknownHeaders.push(table[0][i]);
  });
  if (index[spec.required] === undefined) fail(`The file needs a “${spec.headers[0]}” column.`);
  const ctx = await spec.context(db, { orgId, entityId });
  const seen = new Set(), earlier = [];
  const rows = table.slice(1).filter(cells => cells.some(c => String(c ?? '').trim())).map((cells, i) => {
    const values = Object.fromEntries(Object.keys(spec.columns).map(k => [k, index[k] === undefined ? '' : String(cells[index[k]] ?? '').trim()]));
    const key = values[spec.required].toLowerCase();
    let error = !values[spec.required] ? `No ${spec.headers[0].toLowerCase()}.` : seen.has(key) ? 'This name appears twice in the file.' : spec.check(values, ctx, earlier);
    seen.add(key);
    if (!error) earlier.push(values);
    return { line: i + 2, values, error, cells: spec.preview(values) };
  });
  return { rows, unknownHeaders, previewHeads: spec.previewHeads };
}

export async function runImport(pool, { orgId, entityId, kind, csv, actor }) {
  const spec = IMPORTS[kind] ?? fail('Unknown import.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows } = await previewImport(tx, { orgId, entityId, kind, csv });
    const good = rows.filter(r => !r.error);
    if (!good.length) fail('None of the rows can be imported. Fix the errors shown and try again.');
    const ctx = await spec.context(tx, { orgId, entityId });
    try {
      for (const r of good) await spec.insert(tx, { orgId, entityId, actor }, r.values, ctx);
    } catch (error) {
      if (error.code === '23505') fail('Two rows clash with each other or with something already in the books (a name, number or SKU). Check the file and try again.');
      throw error;
    }
    return { created: good.length, skipped: rows.length - good.length };
  });
}
