import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { makeCursor, readCursor } from '../lib/data/morning/cursor.js';

const secret=randomBytes(32);
const payload={sid:'sample-session',vk:'owner',epoch:1,gen:null,kind:'ctx',resource:null,after:null,iat:1000};
const expected={sid:payload.sid,vk:payload.vk,epoch:1,expectedKind:'ctx',expectedResource:null,now:1000};
test('source selectors and hyphenated rules are signed with typed page keys',()=>{
  for(const resource of [{rule:'tax-coverage'},{rule:'new-payee'},{rule:'alerts'},{rule:'freshness'},{rule:'limitations',sourceKey:'feed:1:2026-10-10T00:00:00.000Z'}]) {
    const after=resource.rule==='freshness'?{entityId:1,source:'feed',sourceKey:'feed:1:sample'}:resource.rule==='limitations'?{entityId:1,llAccountId:'00000000-0000-0000-0000-000000000001',kind:'historical_mapping'}:null;
    const p={...payload,kind:'attention',resource,after};const token=makeCursor(secret,p);assert.deepEqual(readCursor(secret,token,{...expected,expectedKind:p.kind,expectedResource:resource}),p);
    assert.deepEqual(readCursor(secret,token,{...expected,expectedKind:p.kind,expectedResource:{...resource,sourceKey:'other'}}),{expired:true});
  }
  for(const resource of [{rule:'tax_coverage'},{rule:'new_payee'},{rule:'limitations'},{rule:'freshness',sourceKey:'unbound'}])assert.throws(()=>makeCursor(secret,{...payload,kind:'attention',resource}));
});
test('null-generation context round-trips exactly; session, viewer, epoch, kind and resource are bound',()=>{
  const token=makeCursor(secret,payload);
  assert.deepEqual(readCursor(secret,token,expected),payload);
  for(const change of [{sid:'other'},{vk:'2'},{epoch:2},{expectedKind:'entries'},{expectedResource:{accountId:1}}])assert.deepEqual(readCursor(secret,token,{...expected,...change}),{expired:true});
  assert.deepEqual(readCursor(secret,token.slice(0,-3)+'AAA',expected),{expired:true});
  assert.deepEqual(readCursor(randomBytes(32),token,expected),{expired:true});
});
test('strict signed shapes reject malformed after, unknown keys/kinds, unsafe IDs and future timestamps',()=>{
  const sign=p=>{const json=JSON.stringify(p,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
    const body=Buffer.from(json).toString('base64url');return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');};
  for(const p of [{...payload,extra:1},{...payload,after:{}},{...payload,kind:'bogus'},{...payload,iat:1001},{...payload,gen:'no'},{...payload,epoch:0},
    {...payload,kind:'account',resource:{accountId:9007199254740992}},{...payload,kind:'entries',after:{date:'2026-10-17',txnId:1}},
    {...payload,resource:{owner:true}},{...payload,kind:'attention',resource:{rule:'all',org_id:1}}])
    assert.deepEqual(readCursor(secret,sign(p),{...expected,expectedKind:p.kind,expectedResource:p.resource}),{expired:true});
  for(const token of ['', 'a.b.c','***.***','e30=.abc'])assert.deepEqual(readCursor(secret,token,expected),{expired:true});
});
test('60 minutes is inclusive; reload preserves comparison and lifetime and only clears after',()=>{
  const p={...payload,gen:randomUUID(),kind:'account',resource:{accountId:7},after:{date:'2026-10-17',entityId:1,txnId:2,accountId:7}};
  const e={...expected,expectedKind:'account',expectedResource:{accountId:7}},token=makeCursor(secret,p);
  assert.deepEqual(readCursor(secret,token,{...e,now:3601000}),p);
  assert.deepEqual(readCursor(secret,token,{...e,now:3601001}),{expired:true});
  const reload=makeCursor(secret,{...readCursor(secret,token,{...e,now:2000}),after:null});
  assert.deepEqual(readCursor(secret,reload,{...e,now:3601000}),{...p,after:null});
  assert.deepEqual(readCursor(secret,reload,{...e,now:3601001}),{expired:true});
});
