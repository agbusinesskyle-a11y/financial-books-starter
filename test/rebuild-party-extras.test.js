import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('vendor/customer extras and extra terms round-trip by natural keys with ciphertext unchanged',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  await q(src,"INSERT INTO terms(org_id,entity_id,name,due_days) VALUES(1,1,'Sample extended',45)");
  await q(dst,"INSERT INTO terms(org_id,entity_id,name,due_days) VALUES(1,1,'Sample unrelated',7)");
  await q(src,`UPDATE vendor SET company_name='Sample supplier',title='Ms',first_name='Sample',middle_name='A',last_name='Person',suffix='Jr',
    cc='copy@example.com',bcc='blind@example.com',mobile='5550101',fax='5550102',other_phone='5550103',website='https://example.com',check_name='Sample check',
    terms_id=(SELECT terms_id FROM terms WHERE name='Sample extended'),default_expense_account_id=(SELECT account_id FROM account WHERE type='expense' LIMIT 1),
    billing_rate_cents=12345,track_1099=true,tax_id_enc='v1:aaa:bbb:ccc',tax_id_last4='1234',bank_routing_enc='v1:ddd:eee:fff',
    bank_account_enc='v1:ggg:hhh:iii',bank_account_last4='9876',bank_changed_at='2026-01-01Z',bank_verified=false,active=false
    WHERE vendor_id=(SELECT min(vendor_id) FROM vendor)`);
  await q(src,`UPDATE customer SET company_name='Sample customer',mobile='5550201',note_line='Sample note',
    terms_id=(SELECT terms_id FROM terms WHERE name='Sample extended'),tax_exempt=true,tax_exempt_reason='Sample exemption',preferred_payment_method='Check',
    preferred_delivery='print',late_fees_enabled=false,active=false,no_reminders=true,title='Dr',middle_name='B',suffix='Sr',
    cc='copy@example.com',bcc='blind@example.com',fax='5550202',other_phone='5550203',website='https://example.com',check_name='Sample customer check',
    parent_customer_id=(SELECT max(customer_id) FROM customer),email_marketing=true,credit_limit_cents=50123,customer_type='Sample type',
    invoice_language='Spanish',source='Sample source',referred_by='Sample referral',job_title='Sample role',contact_role='Sample contact',
    preferred_contact='phone',industry='Sample industry',social='[{"network":"Sample","url":"https://example.com"}]',
    other_addresses='[{"label":"Sample address","line1":"1 Sample St","city":"Sample city","state":"AZ","postal":"85001"}]'
    WHERE customer_id=(SELECT min(customer_id) FROM customer)`);
  const data=await saved(src);
  assert.ok(data.companies[0].vendorExtras?.length);
  assert.ok(data.companies[0].customerExtras?.length);
  const report=await apply(dst,data);
  assert.deepEqual(report.leftovers,[]);
  assert.deepEqual(report.skipped,[]);
  const restored=await saved(dst);
  for(const key of ['vendorExtras','customerExtras','terms']) assert.deepEqual(restored.companies[0][key].filter(x=>x.name!=='Sample unrelated'),data.companies[0][key],key);
  for(const secret of ['v1:aaa:bbb:ccc','v1:ddd:eee:fff','v1:ggg:hhh:iii']) assert.ok(!JSON.stringify(report).includes(secret));
  const again=await apply(dst,data);
  assert.deepEqual(again.leftovers,[]);
  assert.equal((await q(dst,"SELECT count(*) n FROM terms WHERE name='Sample extended'"))[0].n,1);
});

test('unrestorable mixed-owner fields are explicit leftovers',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  await q(src,"UPDATE vendor SET currency='CAD' WHERE vendor_id=(SELECT min(vendor_id) FROM vendor)");
  const data=await saved(src),report=await apply(dst,data);
  assert.ok(report.leftovers?.some(x=>x.table==='vendor'));
  assert.equal((await q(dst,'SELECT currency FROM vendor ORDER BY vendor_id'))[0].currency,null);
});

test('R10 native vendor fields must be saved or surfaced as leftovers',async()=>{
  const src=await makeDb({imported:true});
  await q(src,"UPDATE vendor SET track_1099=true,tax_id_enc='v1:aaa:bbb:ccc',tax_id_last4='1234' WHERE vendor_id=(SELECT min(vendor_id) FROM vendor)");
  const data=await saved(src);
  const hasEvidence=JSON.stringify(data).includes('v1:aaa:bbb:ccc') || data.leftovers.some(x=>x.table==='vendor');
  console.log('R10',JSON.stringify({hasEvidence,leftovers:data.leftovers}));
  assert.equal(hasEvidence,true);
});
