import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvOrg,mvReadyViewers } from './morning-fixtures.js';
import { saveSmsSettings } from '../lib/sms/twilio.js';
import { settingsKey } from '../lib/secrets.js';
import { transportSource,approveTransport } from '../lib/data/morning/transport.js';
import { savePreferences,saveDeliverySettings } from '../lib/data/morning/settings.js';
import { runMorningMessages } from '../lib/data/morning/messages.js';

test('dispatch preflight uses one five-second SQL budget, then releases SECURITY',async t=>{
  const database=await freshDb();t.after(()=>database.drop());const db=database.pool,{orgId}=await mvOrg(db,{slug:'sample'}),{owner}=await mvReadyViewers(db,{orgId,second:false});
  const env={NODE_ENV:'test',APP_ORG:'sample',APP_BASE_URL:'https://books.sample.example',SETTINGS_KEY:'ab'.repeat(32)},N=new Date('2026-10-17T13:35Z');
  await saveSmsSettings(db,{orgId,enabled:true,accountSid:`AC${'ab'.repeat(16)}`,authToken:'cd'.repeat(16),phone:'+16025550190',key:settingsKey(env),actor:'the owner'});
  const source=await transportSource(db,{orgId,channel:'sms',env});await approveTransport(db,{actorCtx:owner,channel:'sms',revision:1,fingerprint:source.fingerprint,env});
  await saveDeliverySettings(db,{actorCtx:owner,enabled:true,env});await savePreferences(db,{actorCtx:owner,fields:{enabled:'1',channel:'sms',phone:'+16025550100',send_time:'06:30',detail_threshold:'500'}});
  let armed=false,start,calls=0,delayed=0;
  const pool={query:(...args)=>db.query(...args),connect:async()=>{
    const client=await db.connect();return {release:(...args)=>client.release(...args),query(config,...args){
      let text=typeof config==='string'?config:config.text;
      if(armed&&delayed<2&&/^SELECT \* FROM morning_(message_claim|delivery_setting) WHERE/.test(text)){
        delayed++;text=text.replace(/^SELECT \* FROM (morning_\w+)/,'WITH hold AS MATERIALIZED (SELECT pg_sleep(3)) SELECT t.* FROM $1 t CROSS JOIN hold');
      }
      return client.query(typeof config==='string'?text:{...config,text},...args);
    }};
  }};
  await runMorningMessages({pool,env,clock:{wall:()=>N,mono:()=>performance.now()},testHooks:{afterPrepare:()=>{armed=true;start=performance.now();},fetchImpl:async()=>{calls++;return new Response('',{status:201});}}});
  const elapsed=performance.now()-start;assert.equal(delayed,2);assert.equal(calls,0);
  assert.ok(elapsed<5500,`preflight and cleanup took ${elapsed} ms`);
  assert.equal((await db.query('SELECT state FROM morning_message_claim')).rows[0].state,'skipped');
  // A writer and a subsequent query work on the same pool after cancellation.
  await saveDeliverySettings(db,{actorCtx:owner,enabled:false,env});assert.equal((await db.query('SELECT 1 n')).rows[0].n,1);
});
