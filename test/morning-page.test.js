import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startApp } from './app-harness.js';
import { mvOrg, mvTxn, mvVendor, mvCustomer, mvApply, mvUser, mvCompleteSetup } from './morning-fixtures.js';
import { trustedActor } from '../lib/data/morning/access.js';
import { grantSecondViewer, ownerResetViewer, removeSecondViewer } from '../lib/data/morning/identity.js';
import { settingsKey, encryptSecret } from '../lib/secrets.js';
import { transportSource } from '../lib/data/morning/transport.js';
import { billsAndInvoices } from '../lib/data/morning/bills.js';

const A='Sample company A', B='Sample company B', H='Sample household A';
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
const href=(body,label)=>{const match=[...body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^]*?)<\/a>/g)].find(m=>m[2].includes(label));assert.ok(match,`link: ${label}`);return decode(match[1]);};
const forms=body=>[...body.matchAll(/<form\b[^>]*action="\/morning\/dismiss"[^>]*>([^]*?)<\/form>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(x=>[x[1],decode(x[2])])));
const findForm=(body,rule)=>{const f=forms(body).find(f=>f.item_key.startsWith(rule+':'));assert.ok(f,rule+' dismissal');return f;};
const payload=path=>JSON.parse(Buffer.from(new URL(path,'http://sample').searchParams.get('c').split('.')[0],'base64url'));
const ids=body=>[...body.matchAll(/data-entry-id="(\d+)"/g)].map(m=>Number(m[1]));
const assertSectionOrder=body=>{
  const summary=body.match(/<main\b[^>]*data-morning-page="summary"[^>]*>([^]*?)<\/main>/);
  assert.ok(summary,'Morning summary is rendered');
  assert.deepEqual([...summary[1].matchAll(/<h2\b[^>]*>([^]*?)<\/h2>/g)].map(m=>m[1]),[
    'Where the money is','What needs attention','Recently added or edited entries — current amounts','Source freshness',
  ]);
};

let fixtureNumber=0;
async function fixture(t,{long=false}={}) {
  const hooks={},sent=[];let f;
  const app=await startApp({now:new Date(+new Date('2026-10-17T13:00:00Z')+fixtureNumber++*16*60000),env:{SETTINGS_KEY:'ab'.repeat(32),APP_BASE_URL:'https://books.sample.example',NODE_ENV:'test'},morningTestHooks:hooks,
    mailer:{kind:'smtp',from:'books@sample.example',send:async message=>{sent.push(message);return {status:'sent'};}},
    seed:async db=>{f=await mvOrg(db,{slug:'sample',companies:[A,B],households:[H]});return {...f,entityId:f.entities[A]};}});
  t.after(()=>app.close());const db=app.db.pool;
  const vendor=await mvVendor(db,{orgId:f.orgId,entityId:f.entities[A],name:'Sample vendor A'});
  const add=(cents,extra={})=>mvTxn(db,{orgId:f.orgId,entityId:f.entities[A],type:'expense',vendorId:vendor,date:'2026-10-17',
    createdAt:new Date(app.clock()),postings:[{accountId:f.accounts[A].checking,cents}],...extra});
  for(const [company,acct,cents] of [[A,'checking',100000],[A,'card',-20000],[B,'checking',250000],[H,'checking',40000]])
    await add(cents,{entityId:f.entities[company],type:'journal_entry',vendorId:null,createdAt:new Date('2026-10-16T12:00:00Z'),postings:[{accountId:f.accounts[company][acct],cents}]});
  const bill=await add(-10000,{type:'bill',dueDate:'2026-10-16',date:'2026-10-01',postings:[{accountId:f.accounts[A].ap,cents:-10000}]});
  const bank=async(company)=>{const ll=randomUUID();await db.query(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by) VALUES($1,$2,$3,$4,'the owner')`,[f.orgId,f.entities[company],randomUUID(),company]);
    await db.query(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id,include) VALUES($1,$2,$3,'Sample bank feed','depository',$4,true)`,[f.orgId,f.entities[company],ll,f.accounts[company].checking]);
    await db.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state) VALUES($1,$2,$3,$4,1,false,'2026-10-17',100,'active','new')`,[f.orgId,f.entities[company],ll,randomUUID()]);return ll;};
  const feeds=[await bank(A),await bank(B)];
  if(long)await db.query('UPDATE entity SET name=$2 WHERE entity_id=$1',[f.entities[B],B+'x'.repeat(120)+'<script>']);
  const state=async()=>({visits:(await db.query('SELECT * FROM morning_visit ORDER BY viewer_key')).rows,generations:(await db.query('SELECT * FROM morning_snapshot_generation ORDER BY generation_id')).rows});
  const page=async(path='/morning',client=app)=>{const r=await client.get(path);assert.equal(r.status,200,await r.clone().text());return r.text();};
  const owner=trustedActor({owner:true},f.orgId,app.ownerSession);
  const viewer=async(role='reports')=>{const u=await mvUser(db,{orgId:f.orgId,email:`viewer${Date.now()}@sample.example`,role});
    const args={actorCtx:owner,orgId:f.orgId,userId:u.userId,key:settingsKey(app.env),now:new Date(app.clock())};
    const issue=await grantSecondViewer(db,args),setup=await mvCompleteSetup(app,{token:issue.token});
    await db.query('UPDATE app_user SET all_companies=false WHERE user_id=$1',[u.userId]);
    const session=app.sessionFor(setup.cookie),get=path=>fetch(app.base+path,{redirect:'manual',headers:{cookie:setup.cookie}});
    const post=(path,body={})=>fetch(app.base+path,{method:'POST',redirect:'manual',headers:{cookie:setup.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:session.csrf,...body})});
    return {...u,...setup,args,get,post,session};};
  const window=async(n=0,cents=-60000,date='2026-10-17')=>{await page();app.advance(61*60000);const txns=[];for(let i=0;i<n;i++)txns.push(await add(cents,{date}));return {body:await page(),txns};};
  return {app,db,f,hooks,add,bill,feeds,state,page,viewer,window,owner,vendor,sent};
}

test('first look page',async t=>{const c=await fixture(t,{long:true}),b=await c.page();assert.match(b,/<title>Morning View · Financial Books<\/title>/);for(const text of ['First look — changes start from now','Cash $','available after cards','Net posted today:','&lt;script&gt;'])assert.ok(b.includes(text),text);assert.doesNotMatch(b,/<script>/);assert.match(b,/data-count="newPayees"[^>]*>0</);});
test('code-r2 R2-N1: missing-party skipped counts appear on summary and computed alert detail', async t => {
  const c = await fixture(t);
  assert.doesNotMatch(await c.page(), /Transaction alerts skipped/);
  c.app.advance(61 * 60000);
  // Review reproduction: three outgoing window seeds with no stable party.
  for (let i = 0; i < 3; i++) await c.add(-120000, { vendorId: null });
  const summary = await c.page(), saved = await c.state();
  const assertCoverage = body => {
    for (const name of ['newPayees', 'large', 'duplicateGroups']) {
      assert.match(body, new RegExp(`data-count="${name}"[^>]*>0<`));
    }
    assert.match(body, /Coverage is incomplete/);
    assert.match(body, /Transaction alerts skipped 3 transactions: missing party identity\./);
    assert.doesNotMatch(body, /Transaction alerts skipped 0/);
  };
  assertCoverage(summary);
  assertCoverage(await c.page(href(summary, 'All attention')));
  for (const path of [href(summary, 'New payee'), href(summary, 'Large transactions'), '/morning/attention?kind=alerts']) {
    const detail = await c.page(path);
    assert.match(detail, /Transaction alerts skipped 3 transactions: missing party identity\./);
    assert.match(detail, /Coverage is incomplete/);
  }
  for (const label of ['All bills', 'Duplicate groups']) {
    assert.doesNotMatch(await c.page(href(summary, label)), /Transaction alerts skipped/);
  }
  assert.deepEqual(await c.state(), saved, 'detail reads do not advance observations');
});

test('code-r2 R2-N1: multiple/conflicting party coverage survives alert dismissal', async t => {
  const c = await fixture(t), a = c.f.accounts[A];
  const otherVendor = await mvVendor(c.db, { orgId: c.f.orgId, entityId: c.f.entities[A], name: 'Sample vendor B' });
  await c.page(); c.app.advance(61 * 60000);
  for (let i = 0; i < 2; i++) await c.add(-120000, {
    type: 'journal_entry', vendorId: null,
    postings: [{ accountId: a.checking, cents: -120000, vendorId: c.vendor },
      { accountId: a.offset, cents: 120000, vendorId: otherVendor }],
  });
  await c.add(-120000, { postings: [{ accountId: a.checking, cents: -120000, vendorId: otherVendor }] });
  await c.add(-1500000);
  const summary = await c.page();
  const assertCoverage = body => {
    assert.match(body, /Transaction alerts skipped 2 transactions: multiple party identities\./);
    assert.match(body, /Transaction alerts skipped 1 transaction: conflicting party identities\./);
    assert.doesNotMatch(body, /Transaction alerts skipped[^<]*missing party identity/);
    assert.match(body, /Coverage is incomplete/);
  };
  assertCoverage(summary);
  const detailUrl = '/morning/attention?kind=alerts';
  const detail = await c.page(detailUrl);
  assertCoverage(detail);
  for (const rule of ['new-payee', 'large']) {
    assert.equal((await c.app.post('/morning/dismiss', findForm(detail, rule))).status, 303);
  }
  for (const body of [await c.page(), await c.page(detailUrl)]) {
    assertCoverage(body);
    assert.match(body, /data-count="newPayees"[^>]*>0</);
    assert.match(body, /data-count="large"[^>]*>0</);
    assert.ok(forms(body).every(f => !/^(new-payee|large):/.test(f.item_key)));
  }
  c.hooks.loaders = { readSeeds: async () => { throw Object.assign(new Error('Sample unavailable alert source'), { code: '42P01' }); } };
  const unavailable = await c.page(detailUrl);
  assert.match(unavailable, /Transaction alerts unavailable/);
  assert.doesNotMatch(unavailable, /Transaction alerts skipped/);
});

test('code-r1 B4: every transfer suggestion is reachable through signed read-only entry detail', async t => {
  const c = await fixture(t);
  await c.page(); c.app.advance(61 * 60000);
  const pairs = [];
  for (let i = 0; i < 51; i++) {
    const pair = [];
    for (const [company, sign] of [[A, -1], [B, 1]]) pair.push(await c.add(sign * (60000 + i), {
      entityId: c.f.entities[company], type: 'journal_entry', vendorId: null,
      postings: [{ accountId: c.f.accounts[company].checking, cents: sign * (60000 + i) }],
    }));
    pairs.push(pair);
  }
  const summary = await c.page(), saved = await c.state();
  assert.match(summary, /Showing 50 of 51 possible transfers/);
  let url = href(summary, 'All possible transfers'), pages = 0;
  const found = new Set();
  do {
    assert.equal(new URL(url, c.app.base).pathname, '/morning/entries');
    const body = await c.page(url);
    const rows = [...body.matchAll(/data-transfer-out="(\d+)" data-transfer-in="(\d+)"/g)];
    assert.equal(rows.length, pages === 0 ? 50 : 1);
    for (const [, out, incoming] of rows) found.add(`${out}:${incoming}`);
    assert.match(body, /Sample company A/); assert.match(body, /Sample company B/);
    assert.match(body, /Checking/); assert.match(body, /Live list/);
    url = body.includes('More possible transfers') ? href(body, 'More possible transfers') : null;
    assert.ok(++pages <= 2);
  } while (url);
  assert.deepEqual(found, new Set(pairs.map(pair => pair.join(':'))));
  assert.deepEqual(await c.state(), saved, 'transfer pages do not advance observations');
  const wrongView = href(summary, 'All possible transfers').replace('&view=transfers', '');
  assert.equal((await c.app.get(wrongView)).status, 409, 'cursor is bound to transfer view');
});
test('section order on first look: money, attention, entries',async t=>{const c=await fixture(t);assertSectionOrder(await c.page());});
test('code-r1 N1: pending bank warnings render the pending caveat', async t => {
  const c=await fixture(t);
  await c.db.query("UPDATE bank_feed_item SET pending=true,attention='changed' WHERE org_id=$1 AND entity_id=$2",[c.f.orgId,c.f.entities[A]]);
  const body=await c.page();
  assert.match(body,/1 lines need review; 0 new; 1 warnings/);
  assert.match(body,/Pending at bank[^<]*not ready to add[^<]*1/);
});
test('code-r1 N3: invoice attention shows Phoenix calendar days late', async t => {
  const c=await fixture(t),customer=await mvCustomer(c.db,{orgId:c.f.orgId,entityId:c.f.entities[A],name:'Sample customer A'});
  for(const dueDate of ['2026-10-16','2026-10-14'])await c.add(10000,{type:'invoice',vendorId:null,customerId:customer,
    date:'2026-10-01',dueDate,postings:[{accountId:c.f.accounts[A].ar,cents:10000}]});
  const summary=await c.page();
  for(const body of [summary,await c.page(href(summary,'All invoices'))]){
    assert.match(body,/1 day late/);assert.match(body,/3 days late/);
  }
});
test('code-r1 N3: duplicate members label historical edits and current entry amounts', async t => {
  const c=await fixture(t);
  const historical=await c.add(-40000,{date:'2026-10-16',createdAt:new Date('2026-10-16T12:00:00Z')});
  await c.page();c.app.advance(61*60000);
  await c.db.query('UPDATE txn SET updated_at=$2 WHERE txn_id=$1',[historical,new Date(c.app.clock())]);
  await c.add(-40000,{date:'2026-10-16'});
  const summary=await c.page(),body=await c.page(href(summary,'View members'));
  const row=new RegExp(`<li data-member-id="${historical}">([^]*?)</li>`).exec(body)[1];
  assert.match(row,/Historical entry edited/);
  assert.match(row,/edit may not have changed money/);
  assert.match(row,/Current entry amount/);
  assert.match(row,/400\.00/);
});
test('second look after an hour',async t=>{const c=await fixture(t);await c.db.query('UPDATE morning_preference SET detail_threshold_cents=0,settings_version=settings_version+1');await c.page();c.app.advance(61*60000);const id=await c.add(-5000),b=await c.page();assert.match(b,/Available after cards down \$50\.00 since the comparison look/);assert.ok(b.indexOf(`data-entry-id="${id}"`)>b.indexOf('Recently added or edited entries — current amounts'));assertSectionOrder(b);});
test('incomplete page',async t=>{const c=await fixture(t);await c.add(9007199254740000,{type:'journal_entry',vendorId:null});await c.add(9007199254740000,{type:'journal_entry',vendorId:null,postings:[{accountId:c.f.accounts[A].savings,cents:9007199254740000}]});const b=await c.page();assert.match(b,/Incomplete — some balances unavailable/);assert.doesNotMatch(b,/Cash \$/);assert.equal((await c.state()).generations.length,0);assertSectionOrder(b);});
for(const [loader,label] of [
  ['readBalanceVector','Balances'],['readWindowEntries','Recent entries'],['transferSuggestions','Transfer suggestions'],
  ['bankReview','Bank review'],['billsAndInvoices','Bills and invoices'],['taxAttention','Tax calendar'],
  ['floorItems','Balance floors'],['readSeeds','Transaction alerts'],['buildDuplicateItems','Possible duplicates'],
  ['sourceFreshness','Source freshness'],
])test(`section order with ${label} unavailable`,async t=>{
  const c=await fixture(t);await c.page();c.app.advance(61*60000);
  c.hooks.loaders={[loader]:async()=>{throw Object.assign(new Error('Sample section unavailable'),{code:'42P01'});}};
  const b=await c.page();assert.ok(b.includes(`${label} unavailable (ref `));assertSectionOrder(b);
});
test('detail pages are read-only and live',async t=>{const c=await fixture(t),{body}=await c.window(60),link=href(body,'more entries'),before=await c.state();const b=await c.page(link);assert.match(b,/Live list — edits may change later pages or move entries between pages\. Reload from the beginning for a fresh view/);assert.deepEqual(await c.state(),before);const other=await c.viewer();let r=await other.get(link);assert.equal(r.status,409);assert.match(await r.text(),/This view expired\. Reload Morning View\./);c.app.advance(3600001);r=await c.app.get(link);assert.equal(r.status,409);assert.match(await r.text(),/This view expired\. Reload Morning View\./);});
test('removed account detail',async t=>{const c=await fixture(t),account=c.f.accounts[A].savings;await c.page();await c.db.query('DELETE FROM account WHERE account_id=$1',[account]);const b=await c.page(`/morning/accounts/${account}`);assert.match(b,/No longer in the supported accounts/);assert.match(b,/Savings/);assert.equal((await c.app.get('/morning/accounts/999999')).status,404);});
test('ordinary links respect access',async t=>{const c=await fixture(t),b=await c.page();assert.ok(b.includes(`/banking?account=${c.feeds[0]}`));assert.ok(!b.includes(`/banking?account=${c.feeds[1]}`));assert.match(b,/Sample company B → Banking → Review/);const w=await c.viewer();assert.equal((await w.get('/customers')).status,403);const wb=await c.page('/morning',w);assert.match(wb,/Action unavailable with your current access/);assert.doesNotMatch(wb,/href="\/banking/);});
test('duplicate pages',async t=>{const c=await fixture(t),{body}=await c.window(60,-40000);assert.match(body,/60 entries · 1,770 qualifying pairs/);const before=await c.state(),pairs=href(body,'View pairs'),members=href(body,'View members');const pb=await c.page(pairs),mb=await c.page(members);assert.equal((pb.match(/data-pair-lo=/g)||[]).length,50);assert.equal((mb.match(/data-member-id=/g)||[]).length,50);assert.ok(href(pb,'More pairs'));assert.ok(href(mb,'More members'));assert.deepEqual(await c.state(),before);await c.db.query("UPDATE txn SET updated_at='2026-10-16',created_at='2026-10-16' WHERE type='expense'");assert.match(await c.page(pairs),/This group no longer exists\./);});
test('phone width CSS',async()=>{const css=await readFile(new URL('../public/app.css',import.meta.url),'utf8');assert.match(css,/@media\s*\(max-width:\s*600px\)\s*\{[^]*?\.morning-accounts/);assert.match(css,/\.morning[^]*?overflow-wrap:\s*anywhere/);});
test('no-store',async t=>{const c=await fixture(t);for(const path of ['/morning',`/morning/accounts/${c.f.accounts[A].checking}`,'/morning/entries','/morning/attention','/morning/dismissed','/settings/morning']){const r=await c.app.get(path);assert.equal(r.status,200,path);assert.equal(r.headers.get('cache-control'),'no-store');}});
test('deferred mutation HTTP tests',async t=>{const c=await fixture(t),body=await c.page(),bill=findForm(body,'bill'),before=await c.state();assert.equal(payload(href(body,'All entries')).gen,null);assert.equal((await c.app.post('/morning/dismiss',{...bill,ctx:''})).status,409);assert.equal((await c.app.post('/morning/dismiss',{...bill,ctx:new URL(href(body,'All entries'),'http://sample').searchParams.get('c')})).status,409);
  assert.equal((await c.app.post('/morning/dismiss',{...bill,item_version:'0'.repeat(64)})).status,409);assert.equal((await c.app.post('/morning/dismiss',{...bill,note:'x'.repeat(501)})).status,422);
  assert.equal((await c.app.post('/morning/dismiss',{...bill,note:'x'.repeat(500)})).status,303);assert.equal((await c.db.query('SELECT note FROM morning_dismissal WHERE item_key=$1',[bill.item_key])).rows[0].note.length,500);
  assert.equal((await c.app.post('/morning/dismiss',{...bill,note:'<b>x</b>'})).status,303);assert.match(await c.page('/morning/dismissed'),/&lt;b&gt;x&lt;\/b&gt;/);
  const w=await c.viewer();assert.equal((await w.post('/morning/undismiss',{item_key:bill.item_key})).status,303);assert.equal((await c.db.query('SELECT * FROM morning_dismissal WHERE item_key=$1',[bill.item_key])).rowCount,1);
  const wb=await c.page('/morning',w);assert.ok(forms(wb).some(f=>f.item_key===bill.item_key));assert.equal((await c.app.post('/morning/dismiss',{...bill,ctx:findForm(wb,'bill').ctx})).status,409);
  const payment=await c.add(-10000,{type:'bill_payment'});await mvApply(c.db,{orgId:c.f.orgId,creditTxnId:payment,chargeTxnId:c.bill,cents:10000,on:'2026-10-17'});
  const stale=await c.page('/morning/dismissed?fold=stale');assert.match(stale,/No longer in this view/);assert.match(stale,/&lt;b&gt;x&lt;\/b&gt;/);assert.doesNotMatch(stale,/Sample vendor A|\$100\.00/);
  assert.equal((await c.app.post('/morning/undismiss',{item_key:bill.item_key})).status,303);assert.equal((await c.db.query('SELECT * FROM morning_dismissal WHERE item_key=$1',[bill.item_key])).rowCount,0);
  assert.equal((await c.app.post('/morning/dismiss',{...bill,item_key:'freshness:sample'})).status,422);assert.deepEqual((await c.state()).visits.filter(v=>v.viewer_key==='owner'),before.visits);
  assert.equal((await c.app.post('/settings/morning/floors',{account_id:c.f.accounts[A].checking,floor:'100.00'})).status,303);assert.equal((await c.db.query("SELECT floor_cents FROM morning_floor WHERE viewer_key='owner'")).rows[0].floor_cents,10000);
  assert.equal((await c.app.post('/settings/morning/company-threshold',{entity_id:c.f.entities[A],threshold:'25000.00'})).status,303);assert.equal((await c.db.query('SELECT large_threshold_cents FROM morning_company_setting')).rows[0].large_threshold_cents,2500000);
});
test('live edits/reload',async t=>{const c=await fixture(t);await c.db.query("SELECT setval(pg_get_serial_sequence('txn','txn_id'),100000)");const {body,txns}=await c.window(120,-60000,'2026-10-16'),next=href(body,'more entries'),before=await c.state();assert.deepEqual(txns,Array.from({length:120},(_,i)=>100001+i));assert.deepEqual(ids(body),txns.slice(0,50));const inserted=await c.add(-60000);await c.db.query('DELETE FROM txn WHERE txn_id=$1',[txns[59]]);for(const id of [txns[60],txns[61]]){await c.db.query("UPDATE txn SET txn_date='2026-10-17' WHERE txn_id=$1",[id]);await c.db.query("UPDATE posting SET txn_date='2026-10-17' WHERE txn_id=$1",[id]);}c.app.advance(1000);
  const b=await c.page(next);assert.equal(ids(b)[0],txns[50]);assert.ok(ids(b).includes(txns[58]));for(const id of txns.slice(59,62))assert.ok(!ids(b).includes(id));assert.match(b,/data-entry-count="120"/);
  const reload=href(b,'Reload from the beginning'),p=payload(next),rp=payload(reload);assert.equal(rp.gen,p.gen);assert.equal(rp.iat,p.iat);assert.equal(rp.after,null);assert.deepEqual(ids(await c.page(reload)),[txns[60],txns[61],inserted,...txns.slice(0,47)]);assert.deepEqual(await c.state(),before);
});
test('all operation races',async t=>{for(const action of ['reset','remove/regrant'])for(const kind of ['account','entries','attention','duplicate-members','duplicate-pairs','dismissed','settings','dismiss','undismiss','preferences','floors'])await t.test(kind+' '+action,async t=>{const c=await fixture(t);
  await removeSecondViewer(c.db,{actorCtx:c.owner,orgId:c.f.orgId});const w=await c.viewer(),body=await c.page('/morning',w),bill=findForm(body,'bill');
  const path=kind==='account'?`/morning/accounts/${c.f.accounts[A].checking}`:kind.startsWith('duplicate-')?'/morning/attention?kind=duplicates&group=sample&view='+kind.slice(10):['settings','preferences','floors'].includes(kind)?'/settings/morning'+(kind==='settings'?'':'/'+kind):'/morning/'+kind;
  c.hooks.afterRouteCheck=async()=>{delete c.hooks.afterRouteCheck;let issue;if(action==='reset')issue=await ownerResetViewer(c.db,{...w.args,now:new Date(c.app.clock())});else{await removeSecondViewer(c.db,w.args);issue=await grantSecondViewer(c.db,{...w.args,now:new Date(c.app.clock())});}await mvCompleteSetup(c.app,{token:issue.token});};
  const post=['dismiss','undismiss','preferences','floors'].includes(kind),r=await (post?w.post(path,{...bill,account_id:c.f.accounts[A].checking,floor:'100.00'}):w.get(path));assert.equal(r.status,post?401:303,kind+' '+action);if(!post)assert.match(r.headers.get('location'),/^\/login/);
});});
test('company scopes/inactive display',async t=>{
  const c=await fixture(t),a=c.f.entities[A],bId=c.f.entities[B];
  const insert=async(name)=>(await c.db.query("INSERT INTO account(org_id,entity_id,name,type,active) VALUES($1,$2,$3,'bank',false) RETURNING account_id",[c.f.orgId,a,name])).rows[0].account_id;
  const moved=await insert('Sample moved account'),zeroed=await insert('Sample zeroed account');
  await c.add(100,{type:'journal_entry',vendorId:null,postings:[{accountId:zeroed,cents:100}]});
  await c.db.query('UPDATE account SET active=false WHERE account_id=$1',[c.f.accounts[A].savings]);await c.page();c.app.advance(61*60000);
  await c.db.query('UPDATE account SET entity_id=$2 WHERE account_id=$1',[moved,bId]);
  const entered=await insert('Sample entered account');await c.add(-100,{type:'journal_entry',vendorId:null,postings:[{accountId:zeroed,cents:-100}]});
  await c.db.query("UPDATE account SET type='other_current_asset' WHERE account_id=$1",[c.f.accounts[B].checking]);
  const b=await c.page();assert.ok(b.includes('Includes accounts entering or leaving the supported accounts; this is not a cash movement.'));
  assert.ok(b.includes(`Sample company A (${a}), bank → Sample company B (${bId}), bank`));
  assert.ok(!b.includes(`data-account-id="${c.f.accounts[A].savings}"`));for(const id of [zeroed,entered])assert.ok(b.includes(`data-account-id="${id}"`));
  const before=await c.state();c.hooks.beforeRender=()=>{throw new Error('sample layout failure');};assert.equal((await c.app.get('/morning')).status,500);assert.deepEqual(await c.state(),before);
});
for(const home of ['EUR',''])test(`R2-2 document currency coverage: ${home||'unknown'}`,async t=>{const c=await fixture(t);const bv=await mvVendor(c.db,{orgId:c.f.orgId,entityId:c.f.entities[B],name:'Sample vendor B'});await c.add(-10000,{entityId:c.f.entities[B],type:'bill',vendorId:bv,date:'2026-10-01',dueDate:'2026-10-16',postings:[{accountId:c.f.accounts[B].ap,cents:-10000}]});for(const company of [A,B]){const customer=await mvCustomer(c.db,{orgId:c.f.orgId,entityId:c.f.entities[company],name:'Sample customer A'});await c.add(10000,{entityId:c.f.entities[company],type:'invoice',vendorId:null,customerId:customer,date:'2026-10-01',dueDate:'2026-10-16',postings:[{accountId:c.f.accounts[company].ar,cents:10000}]});}await c.db.query("INSERT INTO currency_settings(org_id,entity_id,home,turned_on_by) VALUES($1,$2,$3,'the owner')",[c.f.orgId,c.f.entities[B],home]);const b=await c.page();assert.match(b,/Incomplete — some balances unavailable/);assert.doesNotMatch(b,/Cash \$/);for(const kind of ['bills','invoices']){const d=await c.page(href(b,kind==='bills'?'All bills':'All invoices'));assert.match(d,/data-count="(?:bills|overdueInvoices)"[^>]*>2</);assert.match(d,/\$100\.00/);assert.match(d,/Amount unavailable — unsupported home currency/);assert.match(d,/data-total="(?:bill|invoice)" data-cents="unavailable"/);}});
test('R2-1 unavailable dismissals never become absent',async t=>{const c=await fixture(t),body=await c.page(),bill=findForm(body,'bill'),bank=findForm(body,'bank');for(const form of [bill,bank])assert.equal((await c.app.post('/morning/dismiss',{...form,note:form===bill?'Sample bill note':'Sample bank note'})).status,303);const before=await c.state(),stored=(await c.db.query('SELECT * FROM morning_dismissal ORDER BY item_key')).rows;c.hooks.loaders={billsAndInvoices:async()=>{throw Object.assign(new Error('SELECT private_table'),{code:'42P01'});}};
  const b=await c.page('/morning/dismissed'),stale=await c.page('/morning/dismissed?fold=stale');assert.match(b,/Results are incomplete; some sections are unavailable/);assert.match(b,/data-matching-count="unavailable"/);assert.match(b,/Sample bank note/);assert.doesNotMatch(stale,/Sample bill note/);assert.deepEqual((await c.db.query('SELECT * FROM morning_dismissal ORDER BY item_key')).rows,stored);assert.deepEqual(await c.state(),before);c.hooks.loaders={billsAndInvoices};assert.match(await c.page('/morning/dismissed'),/Sample bill note/);
});
test('valid settings success matrix persists exact fields and copy-only grant',async t=>{
  const c=await fixture(t),org=c.f.orgId;
  await c.db.query(`INSERT INTO sms_settings(org_id,enabled,account_sid,auth_token_enc,phone,updated_by) VALUES($1,true,$2,$3,'+16025550190','the owner')`,[org,`AC${'ab'.repeat(16)}`,encryptSecret(settingsKey(c.app.env),'cd'.repeat(16))]);
  await c.db.query("INSERT INTO morning_transport(org_id,channel) VALUES($1,'sms')",[org]);
  const source=await transportSource(c.db,{orgId:org,channel:'sms',env:c.app.env});
  assert.equal((await c.app.post('/settings/morning/transport-approve',{channel:'sms',revision:source.row.source_revision,fingerprint:source.fingerprint})).status,303);
  const transport=(await c.db.query("SELECT * FROM morning_transport WHERE channel='sms'")).rows[0];
  assert.equal(transport.suspended,false);assert.equal(transport.approved_revision,source.row.source_revision);assert.equal(transport.approved_fingerprint,source.fingerprint);
  assert.equal((await c.db.query('SELECT settings_version FROM morning_delivery_setting')).rows[0].settings_version,2);
  assert.equal((await c.app.post('/settings/morning/preferences',{enabled:'1',send_time:'06:30',channel:'sms',phone:'+16025550100',include_amounts:'',detail_threshold:'500'})).status,303);
  const p=(await c.db.query("SELECT * FROM morning_preference WHERE viewer_key='owner'")).rows[0];
  assert.deepEqual([p.enabled,p.settings_version,p.send_minute,p.channel,p.phone,p.include_amounts,p.detail_threshold_cents],[true,2,390,'sms','+16025550100',false,50000]);
  assert.equal((await c.app.post('/settings/morning/delivery',{enabled:'1'})).status,303);
  const d=(await c.db.query('SELECT * FROM morning_delivery_setting')).rows[0];assert.equal(d.delivery_enabled,true);assert.equal(d.settings_version,3);
  const u=await mvUser(c.db,{orgId:org,email:'candidate@sample.example'});
  const r=await c.app.post('/settings/morning/viewer',{action:'grant',user_id:u.userId});assert.equal(r.status,200);assert.match(await r.text(),/It was not emailed\./);
  const v=(await c.db.query('SELECT * FROM morning_viewer WHERE user_id=$1',[u.userId])).rows[0];assert.equal(v.enrollment_state,'pending_enrollment');assert.equal(v.membership_epoch,1);assert.deepEqual(c.sent,[]);
});
test('company allocation uses copied metadata and exact per-company changes',async t=>{
  const c=await fixture(t);
  await c.add(-99000,{type:'journal_entry',vendorId:null});
  await c.add(19500,{type:'journal_entry',vendorId:null,postings:[{accountId:c.f.accounts[A].card,cents:19500}]});
  await c.add(-249300,{entityId:c.f.entities[B],type:'journal_entry',vendorId:null,postings:[{accountId:c.f.accounts[B].checking,cents:-249300}]});
  await c.page();c.app.advance(61*60000);await c.add(500);await c.add(-300,{postings:[{accountId:c.f.accounts[A].card,cents:-300}]});
  await c.db.query("UPDATE account SET type='other_current_asset' WHERE account_id=$1",[c.f.accounts[B].checking]);
  const b=await c.page();assert.match(b,/Cash change \+\$5\.00 · available after cards change \+\$2\.00/);assert.match(b,/Cash change −\$7\.00 · available after cards change −\$7\.00/);assert.match(b,/Sample company B/);
});
test('attention selectors and forged duplicate resource',async t=>{
  const c=await fixture(t);await c.page();const b=await c.page('/morning/attention?kind=alerts');assert.ok(forms(b).every(f=>/^(floor|new-payee|large):/.test(f.item_key)));
  assert.equal((await c.app.get('/morning/attention?kind=duplicates&group=sample&view=members')).status,409);
  assert.equal((await c.app.get('/morning/attention?kind=limitations&source=foreign')).status,409);
});
test('credit card detail normalizes owed once',async t=>{
  const c=await fixture(t);await c.page();const b=await c.page(`/morning/accounts/${c.f.accounts[A].card}`);assert.match(b,/data-value="account-balance" data-cents="20000">\$200\.00/);
});
test('safe maximum cents render exactly without fractional-dollar rounding',async t=>{
  const c=await fixture(t);await c.add(Number.MAX_SAFE_INTEGER-390000,{type:'journal_entry',vendorId:null});
  assert.ok((await c.page()).includes('Cash $90,071,992,547,409.91'));
});
