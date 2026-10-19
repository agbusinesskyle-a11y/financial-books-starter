import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { withTransaction } from '../lib/db.js';
import { createCompanyIn } from '../lib/data/companies.js';
import { encryptSecret, settingsKey } from '../lib/secrets.js';
import { makeTotp, createAuth } from '../lib/auth.js';
import { ensureOwnerViewer, trustedActor } from '../lib/data/morning/access.js';
import { grantSecondViewer } from '../lib/data/morning/identity.js';
import { findOpenInvite, pendingSecret, completeInvite, sessionUser } from '../lib/data/users.js';

// Original auth sessions, including a completed protected enrollment, for read-model tests.
export async function mvReadyViewers(db, { orgId, slug = 'mvtest', second = true }) {
  const auth = createAuth({ env: { DEV_NO_AUTH: '1' } });
  await ensureOwnerViewer(db, orgId);
  const owner = trustedActor({ owner: true }, orgId, auth.current({ headers: {} }).session);
  if (!second) return { owner };
  const key = settingsKey({ SETTINGS_KEY: 'ab'.repeat(32) });
  const now = new Date('2026-10-17T15:00:00Z');
  const user = await mvUser(db, { orgId, email: 'viewer@sample.example' });
  const { token } = await grantSecondViewer(db, { orgId, userId: user.userId, actorCtx: owner, key, now });
  const invite = await findOpenInvite(db, { token, orgSlug: slug, now });
  const secret = await pendingSecret(db, { invite, key });
  const done = await completeInvite(db, { token, orgSlug: slug, key, now, password: user.password,
    password2: user.password, code: makeTotp(secret).generate({ timestamp: now.getTime() }) });
  const cookie = auth.signIn(done).split(';')[0];
  const session = auth.current({ headers: { cookie } }).session;
  return { owner, second: trustedActor(await sessionUser(db, session), orgId, session) };
}

// A supplied client belongs to its caller's transaction; a pool gets a dedicated one.
const inTransaction = (db, fn) => typeof db.release === 'function' ? fn(db) : withTransaction(db, fn);

export async function mvOrg(db, { slug = 'mvtest', companies = ['Sample company A', 'Sample company B'], households = [] } = {}) {
  return inTransaction(db, async tx => {
    const { rows: [o] } = await tx.query(`INSERT INTO org (slug, name) VALUES ($1, 'Sample organization') RETURNING org_id`, [slug]);
    const entities = {}, accounts = {};
    for (const name of [...new Set([...companies, ...households])]) {
      const entityId = await createCompanyIn(tx, { orgId: o.org_id, name, timeZone: 'America/Phoenix' });
      entities[name] = entityId;
      const { rows } = await tx.query('SELECT account_id, name, system_key FROM account WHERE org_id=$1 AND entity_id=$2', [o.org_id, entityId]);
      const byName = Object.fromEntries(rows.map(a => [a.name, a.account_id]));
      const byKey = Object.fromEntries(rows.map(a => [a.system_key, a.account_id]));
      accounts[name] = { checking: byName.Checking, savings: byName.Savings, card: byName['Credit Card'], offset: byKey.opening_equity,
        ar: byKey.ar, ap: byKey.ap, undeposited: byKey.undeposited };
      if (households.includes(name)) await tx.query(`INSERT INTO tax_profile (org_id, entity_id, return_type) VALUES ($1,$2,'household_1040')`, [o.org_id, entityId]);
    }
    return { orgId: o.org_id, entities, accounts };
  });
}

export async function mvVendor(db, { orgId, entityId, name }) {
  return (await db.query('INSERT INTO vendor (org_id, entity_id, display_name) VALUES ($1,$2,$3) RETURNING vendor_id', [orgId, entityId, name])).rows[0].vendor_id;
}
export async function mvCustomer(db, { orgId, entityId, name }) {
  return (await db.query('INSERT INTO customer (org_id, entity_id, display_name) VALUES ($1,$2,$3) RETURNING customer_id', [orgId, entityId, name])).rows[0].customer_id;
}

export async function mvTxn(db, { orgId, entityId, type, date, postings, vendorId = null, customerId = null,
  docDate = date, dueDate = null, approval = null, createdAt = new Date('2026-10-17T15:00:00Z'), updatedAt = createdAt,
  voided = false, accountId, totalCents, lineParties = [] }) {
  return inTransaction(db, async tx => {
    const own = async (table, column, id) => {
      if (id != null) assert.equal((await tx.query(`SELECT 1 FROM ${table} WHERE org_id=$1 AND entity_id=$2 AND ${column}=$3`, [orgId, entityId, id])).rowCount, 1, `same-company ${column} required`);
    };
    await own('vendor', 'vendor_id', vendorId);
    await own('customer', 'customer_id', customerId);
    if (['invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate'].includes(type)) assert.ok(customerId, 'customer required');
    if (['bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt'].includes(type)) assert.ok(vendorId, 'vendor required');
    if (['deposit', 'journal_entry'].includes(type)) assert.ok(!vendorId && !customerId, 'use posting parties');
    const { rows: accts } = await tx.query('SELECT account_id, type, name, system_key FROM account WHERE org_id=$1 AND entity_id=$2', [orgId, entityId]);
    const legs = postings.map(p => ({ ...p }));
    for (const p of legs) {
      assert.ok(Number.isSafeInteger(p.cents) && p.cents !== 0, 'nonzero safe input cents required');
      await own('account', 'account_id', p.accountId);
      await own('vendor', 'vendor_id', p.vendorId);
      await own('customer', 'customer_id', p.customerId);
    }
    const sum = legs.reduce((s, p) => s + BigInt(p.cents), 0n);
    assert.ok(sum <= BigInt(Number.MAX_SAFE_INTEGER) && sum >= -BigInt(Number.MAX_SAFE_INTEGER));
    if (sum !== 0n) legs.push({ accountId: accts.find(a => a.system_key === 'opening_equity').account_id, cents: -Number(sum) });
    if (accountId === undefined && ['expense', 'check', 'bill_payment', 'cc_credit', 'deposit'].includes(type)) {
      accountId = postings.find(p => accts.some(a => a.account_id === p.accountId && ['bank', 'credit_card'].includes(a.type)))?.accountId
        ?? accts.find(a => a.name === 'Checking').account_id;
    }
    await own('account', 'account_id', accountId);
    const total = voided ? 0 : totalCents ?? legs.reduce((s, p) => s + Math.max(0, p.cents), 0);
    assert.ok(Number.isSafeInteger(total) && total >= 0);
    const open = ['invoice', 'late_fee', 'bill', 'vendor_credit', 'payment', 'bill_payment', 'credit_memo'].includes(type) ? total : 0;
    // Document date and posting date are independent source-schema columns.
    const due = dueDate ?? (['invoice', 'late_fee', 'bill'].includes(type) ? docDate : null);
    const { rows: [t] } = await tx.query(`INSERT INTO txn
      (org_id,entity_id,type,txn_date,due_date,vendor_id,customer_id,account_id,total_cents,open_cents,approval_status,created_at,updated_at,voided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING txn_id`,
    [orgId, entityId, type, docDate, due, vendorId, customerId, accountId ?? null, total, open, type === 'bill' ? approval ?? 'approved' : null, createdAt, updatedAt, voided ? createdAt : null]);
    for (const [i, p] of (voided ? [] : legs).entries()) await tx.query(`INSERT INTO posting
      (org_id,entity_id,txn_id,line_no,account_id,amount_cents,txn_date,vendor_id,customer_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgId, entityId, t.txn_id, i + 1, p.accountId, p.cents, p.date ?? date, p.vendorId ?? null, p.customerId ?? null]);
    for (const [i, p] of lineParties.entries()) {
      await own('account', 'account_id', p.accountId);
      await own('customer', 'customer_id', p.customerId);
      await tx.query(`INSERT INTO txn_line (org_id,txn_id,line_no,account_id,customer_id,amount_cents,po_txn_id,billable_txn_id,estimate_txn_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [orgId, t.txn_id, i + 1, p.accountId ?? null, p.customerId ?? null, p.cents ?? 1, p.poTxnId ?? null, p.billableTxnId ?? null, p.estimateTxnId ?? null]);
    }
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    return t.txn_id;
  });
}

export async function mvApply(db, { orgId, creditTxnId, chargeTxnId, cents, on, viaTxnId = null, creditLineNo = null, chargeLineNo = null }) {
  return inTransaction(db, async tx => {
    await tx.query(`INSERT INTO application (org_id,credit_txn_id,charge_txn_id,amount_cents,applied_on,via_txn_id,credit_line_no,charge_line_no)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [orgId, creditTxnId, chargeTxnId, cents, on, viaTxnId, creditLineNo, chargeLineNo]);
    await tx.query('UPDATE txn SET open_cents=greatest(0,open_cents-$3) WHERE org_id=$1 AND txn_id=ANY($2::bigint[])', [orgId, [creditTxnId, chargeTxnId], cents]);
  });
}

export async function mvUser(db, { orgId, email, role = 'standard', allCompanies = true, password = 'sample password 1', key = 'ab'.repeat(32) }) {
  const totpSecret = new OTPAuth.Secret({ size: 20 }).base32;
  const { rows: [u] } = await db.query(`INSERT INTO app_user (org_id,name,email,role,all_companies,password_hash,totp_enc,signin_version,last_totp_counter)
    VALUES ($1,'the second viewer',$2,$3,$4,$5,$6,0,-1) RETURNING user_id`, [orgId, email, role, allCompanies, await bcrypt.hash(password, 4), encryptSecret(Buffer.isBuffer(key) ? key : settingsKey({ SETTINGS_KEY: key }), totpSecret)]);
  return { userId: u.user_id, totpSecret, password };
}

const cookieOf = res => res.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
const postForm = (app, path, body, cookie) => fetch(app.base + path, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
export async function signInAs(app, { email, password, totpSecret }) {
  const page = await fetch(app.base + '/login');
  const challenge = /name="challenge" value="([^"]+)"/.exec(await page.text())[1];
  app.advance(30_000);
  const res = await postForm(app, '/login', { challenge, email, password, code: makeTotp(totpSecret).generate({ timestamp: app.clock() }) }, cookieOf(page));
  assert.equal(res.status, 303, await res.clone().text());
  const cookie = cookieOf(res), get = path => fetch(app.base + path, { redirect: 'manual', headers: { cookie } });
  const u = (await app.db.pool.query('SELECT role, all_companies FROM app_user WHERE lower(email)=lower($1)', [email])).rows[0];
  const path = u.role === 'customers' ? '/customers' : u.role === 'vendors' ? '/vendors' : '/home';
  let home = await get(path);
  if (home.status === 403) home = await get('/morning');
  const csrf = /name="csrf" value="([^"]+)"/.exec(await home.text())?.[1];
  assert.ok(csrf, 'authenticated page has CSRF');
  return { cookie, csrf, get, post: (path2, body = {}) => postForm(app, path2, { csrf, ...body }, cookie), session: app.sessionFor?.(cookie) };
}

export async function mvCompleteSetup(app, { token, password = 'sample password 1' }) {
  const path = `/invite/${token}`, res = await fetch(app.base + path);
  assert.equal(res.status, 200);
  const html = await res.text(), nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(html)[1].replaceAll(' ', '');
  app.advance(30_000);
  const done = await postForm(app, path, { nonce, password, password2: password, code: makeTotp(secret).generate({ timestamp: app.clock() }) }, cookieOf(res));
  assert.equal(done.status, 303, await done.clone().text());
  const cookie = cookieOf(done);
  await fetch(app.base + '/', { redirect: 'manual', headers: { cookie } });
  const session = app.sessionFor?.(cookie);
  return { cookie, secret, password, userId: session?.userId, version: session?.version };
}
