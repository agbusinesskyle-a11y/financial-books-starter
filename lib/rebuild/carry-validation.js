import { COUNTED_TABLES } from './carry-schema.js';
export { COUNTED_TABLES } from './carry-schema.js';
import { readCarrySnapshot } from './carry-over.js';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireValue = (ok, name) => { if (!ok) throw new Error(`carry-over ${name} is missing or invalid`); };
const countValue = value => Number.isSafeInteger(value) && value >= 0;

export function validateCarryStructure(data) {
  requireValue(data?.version === 1, 'version');
  requireValue(typeof data.savedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(data.savedAt) && Number.isFinite(Date.parse(data.savedAt)), 'savedAt');
  for (const key of ['orgSlug', 'database']) requireValue(typeof data[key] === 'string' && data[key].trim(), key);
  requireValue(Number.isSafeInteger(data.schemaMigrations) && data.schemaMigrations > 0, 'schemaMigrations');
  requireValue(Array.isArray(data.companies), 'companies');
  requireValue(object(data.org), 'org');
  requireValue(Object.hasOwn(data.org, 'ai') && (data.org.ai === null || object(data.org.ai)), 'ai_settings');
  for (const key of ['ledgerlineOrgId','sms','morning','formPrefs']) requireValue(Object.hasOwn(data.org,key), `org.${key}`);
  requireValue(data.org.sms === null || object(data.org.sms), 'org.sms');
  if (data.org.sms) requireValue(Array.isArray(data.org.sms.senders), 'org.sms.senders');
  requireValue(object(data.org.morning), 'org.morning');
  for (const key of ['viewers','preferences']) requireValue(Array.isArray(data.org.morning[key]), `org.morning.${key}`);
  requireValue(Object.hasOwn(data.org.morning,'delivery'), 'org.morning.delivery');
  requireValue(Array.isArray(data.org.formPrefs), 'org.formPrefs');
  requireValue(Array.isArray(data.leftovers) && Array.isArray(data.unclassified), 'leftovers/unclassified');
  for (const table of COUNTED_TABLES) requireValue(countValue(data.counts?.[table]), `${table} count`);
  for (const co of data.companies) {
    requireValue(typeof co?.name === 'string' && co.name.trim(), 'company name');
    requireValue(Object.hasOwn(co, 'feed') && (co.feed === null || object(co.feed)), 'ledgerline_link feed');
    if (co.feed) {
      requireValue(typeof co.feed.llEntityId === 'string', 'ledgerline_link identity');
      requireValue(Array.isArray(co.feed.accounts) && co.feed.accounts.every(a => typeof a?.llAccountId === 'string'), 'ledgerline_account accounts');
    }
    requireValue(Array.isArray(co.rules) && co.rules.every(r => typeof r?.name === 'string' && Array.isArray(r.conditions)), 'bank_rule rules');
    requireValue(Array.isArray(co.userAccess) && co.userAccess.every(u => typeof u?.email === 'string'), 'app_user_company access');
    requireValue(object(co.company), 'company');
    requireValue(object(co.settings), 'settings');
    for (const key of ['email','sales','accounting','bills','payments','lateFees','currency','formStyle']) {
      requireValue(Object.hasOwn(co.settings,key) && (co.settings[key] === null || object(co.settings[key])), `settings.${key}`);
    }
    for (const key of ['accountChanges','loans','nativeApplications','nativeTransactions','researchAttempts','holds','reconciliations','classes','locations','items','vendorExtras','customerExtras','terms','apiTokens','externalRefs']) {
      requireValue(Array.isArray(co[key]), key);
    }
    for (const [key, fields] of Object.entries({
      items: ['name','kind','reorderPoint'], vendorExtras: ['name','taxIdEnc','track1099'],
      customerExtras: ['name','currency'], terms: ['name','dueDays'],
      nativeApplications: ['credit','charge','amountCents','appliedOn'],
      apiTokens: ['tokenId','tokenHash','name','source','scopes','createdBy','createdAt','lastUsedAt','revokedAt','rateWindow','rateCount'],
      externalRefs: ['source','sourceRef','requestHash','createdAt','transaction'],
    })) for (const row of co[key]) requireValue(object(row) && fields.every(f => Object.hasOwn(row,f)), key);
    for (const table of COUNTED_TABLES.filter(t => t !== 'ai_settings')) requireValue(countValue(co.counts?.[table]), `${table} company count`);
  }
}

export async function validateCarryCounts(db, data) {
  const current = await readCarrySnapshot(db, { orgSlug: data.orgSlug });
  requireValue(data.database === current.database, 'database identity');
  requireValue(data.schemaMigrations === current.schemaMigrations, 'schemaMigrations count');
  // A source-derived snapshot covers every company/org section, singleton setting,
  // nested row set, filtered mixed-owner surface, leftover and deliberate discard.
  // Required fields come from the saver itself; future fields cannot bypass the gate.
  compareContent(normalizeCarry(data), normalizeCarry(current), '');
}

// These are sets keyed by the same natural identities used by the saver/writers.
// Rules are keyed for uniqueness but ORDERED by effective priority/rule_id precedence.
// Other arrays retain their order (for example account-change history and splits).
const identities = {
  companies: r => typeof r === 'string' ? r : r.name,
  items: r => r.name, vendorExtras: r => r.name, customerExtras: r => r.name,
  terms: r => r.name, classes: r => [r.parent, r.name], locations: r => r.name, rules: r => r.name,
  accounts: r => r.llAccountId, loans: r => r.account, userAccess: r => r.email,
  holds: r => r.llTransactionId, researchAttempts: r => [r.payeeKey, r.at],
  reconciliations: r => [r.account, r.statementDate],
  apiTokens: r => r.tokenId, externalRefs: r => [r.source, r.sourceRef],
  nativeTransactions: r => r, txns: r => r, nativeApplications: r => r,
  lines: r => r.lineNo, depositLines: r => r.lineNo,
  postings: r => r, applications: r => r, tags: r => r,
  viewers: r => r.viewerKey, preferences: r => r.viewerKey,
  senders: r => r.phone, formPrefs: r => [r.userKey, r.formType],
  leftovers: r => r.table, discarded: r => r.table,
  unclassified: r => r, feedItems: r => r, llAccountIds: r => r,
};
// Only writer bookkeeping is volatile. Business dates, bankChangedAt, settlement
// dates and all encrypted strings are compared exactly, without decoding secrets.
const volatile = new Set(['savedAt', 'createdAt', 'updatedAt']);
// Complete transaction identities are multisets: separate documents (or postings)
// may legitimately be identical. Comparing full content and multiplicity still
// rejects replacing a distinct document with a duplicate.
// Account history also permits repeated edits; it retains sequence order.
const multisets = new Set(['nativeTransactions','txns','nativeApplications','postings','applications','accountChanges']);
export function normalizeCarry(value, path = '') {
  if (Array.isArray(value)) {
    const collection = path.split('.').at(-1), key = identities[collection];
    const seen = new Set();
    const rows = value.map((r, i) => {
      const normalized = normalizeCarry(r, `${path}[${i}]`);
      let identity;
      try { identity = JSON.stringify(key ? key(normalized) : normalized); }
      catch { throw new Error(`carry-over ${path}[${i}] invalid natural identity`); }
      if (!multisets.has(collection) && seen.has(identity)) throw new Error(`carry-over ${path}[${i}] duplicate natural identity`);
      seen.add(identity);
      return { identity, normalized };
    });
    if (key && path.split('.').at(-1) !== 'rules') rows.sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
    return rows.map(r => r.normalized);
  }
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().filter(k => !volatile.has(k))
    .map(k => [k, normalizeCarry(value[k], path ? `${path}.${k}` : k)]));
  return value;
}

function compareContent(saved, current, path) {
  const mismatch = () => { throw new Error(`carry-over ${path} content mismatch`); };
  if (Array.isArray(current)) {
    if (!Array.isArray(saved) || saved.length !== current.length) mismatch();
    for (let i=0; i<current.length; i++) compareContent(saved[i], current[i], `${path}[${i}]`);
  } else if (object(current)) {
    if (!object(saved)) mismatch();
    for (const key of [...new Set([...Object.keys(current), ...Object.keys(saved)])].sort()) {
      const name = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(saved,key) || !Object.hasOwn(current,key)) throw new Error(`carry-over ${name} is missing or unexpected`);
      compareContent(saved[key],current[key],name);
    }
  } else if (saved !== current) mismatch();
}
