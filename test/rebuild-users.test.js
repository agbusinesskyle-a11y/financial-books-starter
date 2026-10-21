import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R8 saved viewer and form preferences must not retain internal user IDs',async()=>{
  const d=await makeDb();
  await q(d,"INSERT INTO app_user(org_id,name,email,role) VALUES(1,'Sample user','sample@example.com','admin')");
  await q(d,"INSERT INTO morning_viewer(org_id,viewer_key,user_id,enrollment_state) VALUES(1,'1',1,'ready')");
  await q(d,"INSERT INTO morning_preference(org_id,viewer_key,membership_epoch) VALUES(1,'1',1)");
  await q(d,"INSERT INTO form_save_pref(org_id,user_key,form_type,choice) VALUES(1,'u:1','invoice','close')");
  const data=await saved(d);
  console.log('R8',JSON.stringify(data.org));
  assert.equal(data.org.formPrefs[0].userKey,'email:sample@example.com','keep the field, resolve its value to email');
  assert.equal(data.org.morning.viewers[0].viewerKey,'email:sample@example.com');
  assert.equal(data.org.morning.preferences[0].viewerKey,'email:sample@example.com');
  const dst=await makeDb();
  await q(dst,"INSERT INTO app_user(org_id,name,email,role) VALUES(1,'Sample unrelated','unrelated@example.com','admin'),(1,'Sample user','sample@example.com','admin')");
  await q(dst,"INSERT INTO morning_viewer(org_id,viewer_key,user_id,enrollment_state) VALUES(1,'2',2,'ready')");
  await q(dst,"INSERT INTO morning_preference(org_id,viewer_key,membership_epoch,send_minute) VALUES(1,'2',1,500)");
  const report=await apply(dst,data);
  assert.deepEqual(report.skipped,[]);
  assert.deepEqual(await q(dst,'SELECT user_key FROM form_save_pref'),[{user_key:'u:2'}]);
  assert.equal((await q(dst,"SELECT send_minute FROM morning_preference WHERE viewer_key='2'"))[0].send_minute,390);
});
