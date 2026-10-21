import { isDeepStrictEqual } from 'node:util';
import { saveVendor } from '../data/vendors.js';
import { saveCustomer, ValidationError } from '../data/writes.js';
import { saveTerms } from '../data/catalog.js';
import { centsText } from './keys.js';

const vendorColumns = ['company_name','title','first_name','middle_name','last_name','suffix','cc','bcc','mobile','fax','other_phone',
  'website','check_name','billing_rate_cents','track_1099','tax_id_enc','tax_id_last4','bank_routing_enc','bank_account_enc',
  'bank_account_last4','bank_changed_at','bank_verified','currency','active'];
const customerColumns = ['company_name','mobile','note_line','tax_exempt','tax_exempt_reason','preferred_payment_method','preferred_delivery',
  'late_fees_enabled','active','no_reminders','currency','title','middle_name','suffix','cc','bcc','fax','other_phone','website','check_name',
  'email_marketing','credit_limit_cents','customer_type','invoice_language','source','referred_by','job_title','contact_role','preferred_contact',
  'industry','social','other_addresses'];
const encryptedColumns = ['tax_id_enc','tax_id_last4','bank_routing_enc','bank_account_enc','bank_account_last4','bank_verified','bank_changed_at'];
const camel = key => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const fields = row => Object.fromEntries(Object.entries(row).map(([k,v]) => [camel(k),v]));
const fail = message => { throw new ValidationError(message); };
const normalized = value => JSON.parse(JSON.stringify(value));
const equal = (a,b) => isDeepStrictEqual(normalized(a),normalized(b));
const one = async (db,sql,args) => (await db.query(sql,args)).rows[0];
export const standardTerms = new Map([['Due on receipt',0],['Net 15',15],['Net 30',30],['Net 60',60]]);

export function partyExtras(table, row, { termsName, accountName, customerName }) {
  const columns = table === 'vendor' ? vendorColumns : customerColumns;
  return { name: row.display_name, ...Object.fromEntries(columns.map(c => [camel(c),row[c]])), terms: termsName(row.terms_id),
    ...(table === 'vendor' ? { defaultExpenseAccount: accountName(row.default_expense_account_id) }
      : { parentCustomer: customerName(row.parent_customer_id) }) };
}

async function named(db,scope,table,name) {
  if (name == null) return null;
  const column = table === 'customer' ? 'display_name' : 'name';
  const rows = (await db.query(`SELECT ${table}_id AS id FROM ${table} WHERE org_id=$1 AND entity_id=$2 AND ${column}=$3`,
    [scope.orgId,scope.entityId,name])).rows;
  if (rows.length !== 1) fail(`No unique ${table} for saved extra field.`);
  return rows[0].id;
}

async function currentExtras(db,scope,table,row) {
  const ref = async (kind,id) => id == null ? null : (await one(db,`SELECT ${kind === 'customer' ? 'display_name' : 'name'} AS name
    FROM ${kind} WHERE org_id=$1 AND entity_id=$2 AND ${kind}_id=$3`,[scope.orgId,scope.entityId,id]))?.name
      ?? fail(`Missing ${kind} reference in ${table}.`);
  const terms = await ref('terms',row.terms_id);
  const account = table === 'vendor' ? await ref('account',row.default_expense_account_id) : null;
  const customer = table === 'customer' ? await ref('customer',row.parent_customer_id) : null;
  return partyExtras(table,row,{termsName:()=>terms,accountName:()=>account,customerName:()=>customer});
}

export async function restorePartyExtras(db, scope, co, actor, attempt) {
  for (const term of co.terms ?? []) await attempt('terms',async()=>{
    if (Object.keys(term).some(k => !['name','dueDays'].includes(k))) fail('Unsupported saved terms field.');
    const current = await one(db,'SELECT * FROM terms WHERE org_id=$1 AND entity_id=$2 AND name=$3',[scope.orgId,scope.entityId,term.name]);
    if (current?.due_days === term.dueDays) return;
    const id = await saveTerms(db,{...scope,termsId:current?.terms_id,name:term.name,dueDays:term.dueDays});
    const after = await one(db,'SELECT name,due_days FROM terms WHERE terms_id=$1',[id]);
    if (after.name !== term.name || after.due_days !== term.dueDays) fail('Terms writer cannot preserve the saved fields exactly.');
  },{table:'terms',name:term.name});
  for (const table of ['vendor','customer']) for (const saved of co[`${table}Extras`] ?? []) await attempt(`${table} extras`,async()=>{
    const row = await one(db,`SELECT * FROM ${table} WHERE org_id=$1 AND entity_id=$2 AND display_name=$3`,[scope.orgId,scope.entityId,saved.name]);
    if (!row) fail(`Saved ${table} is missing from the rebuilt import.`);
    const current = await currentExtras(db,scope,table,row);
    if (!isDeepStrictEqual(Object.keys(saved).sort(),Object.keys(current).sort())) fail(`Unsupported or incomplete saved ${table} fields.`);
    if (equal(current,saved)) return;
    const f = { ...fields(row), ...saved, displayName: row.display_name, termsId: await named(db,scope,'terms',saved.terms) };
    if (table === 'vendor') {
      Object.assign(f,row.billing_address ?? {},{billingRate:saved.billingRateCents == null ? '' : centsText(saved.billingRateCents),
        defaultExpenseAccountId:await named(db,scope,'account',saved.defaultExpenseAccount)});
      await saveVendor(db,{...scope,vendorId:row.vendor_id,fields:f,actor});
      // Same SETTINGS_KEY is an operator precondition. Never decrypt/re-encrypt these values.
      await db.query(`UPDATE vendor SET ${encryptedColumns.map((c,i)=>`${c}=$${i+4}`).join(', ')}
        WHERE org_id=$1 AND entity_id=$2 AND vendor_id=$3`,[scope.orgId,scope.entityId,row.vendor_id,...encryptedColumns.map(c=>saved[camel(c)])]);
    } else {
      for (const prefix of ['billing','shipping']) for (const key of ['line1','city','state','postal']) {
        f[prefix + key[0].toUpperCase() + key.slice(1)] = row[`${prefix}_address`]?.[key] ?? null;
      }
      Object.assign(f,{creditLimit:saved.creditLimitCents == null ? '' : centsText(saved.creditLimitCents),
        sendReminders:!saved.noReminders,parentCustomerId:await named(db,scope,'customer',saved.parentCustomer)});
      await saveCustomer(db,{...scope,customerId:row.customer_id,fields:f,actor});
    }
    const after = await one(db,`SELECT * FROM ${table} WHERE ${table}_id=$1`,[row[`${table}_id`]]);
    const restored = await currentExtras(db,scope,table,after);
    if (!equal(saved,restored)) fail(`${table} writer cannot preserve saved fields: ${Object.keys(saved).filter(k=>!equal(saved[k],restored[k])).join(', ')}.`);
  },{table,name:saved.name});
}
