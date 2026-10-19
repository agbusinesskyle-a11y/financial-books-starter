import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { mvReadyViewers } from './morning-fixtures.js';
import { createMorningService } from '../lib/data/morning.js';

const expectation={id:'comparison',scenario:'comparison',path:'/morning',pathname:'/morning',status:200,title:'Morning View · Financial Books',heading:'Morning View',identity:'summary',
  texts:['Cash $204,000.00','available after cards $194,000.00'],values:[{selector:'[data-value="cash"]',attribute:'data-cents',equals:'20400000'}],requiredLinks:[{selector:'a[href*="view=pairs"]',minLinks:1}]};
const valid=()=>({status:200,pathname:'/morning',title:expectation.title,heading:'Morning View',identity:'summary',text:expectation.texts.join(' '),html:'Sample',
  inner:390,scroll:390,errors:[],values:[{count:1,value:'20400000'}],links:[{count:1}],grandCount:2});
async function refusal(change,expected=expectation){
  const {assessMorningPage,pageCheckExitCode}=await import('../scripts/check-morning-pages.mjs');
  const actual=valid();change(actual);
  const problems=assessMorningPage(expected,actual,{width:390});
  assert.ok(problems.length,'invalid page must not pass');assert.equal(pageCheckExitCode({checked:1,problems}),1);
}
test('login redirect is a failed page check',()=>refusal(o=>{o.pathname='/login';o.title='Sign in · Financial Books';o.heading='Sign in';o.identity=null;}));
test('wrong document status is a failed page check',()=>refusal(o=>{o.status=503;}));
test('wrong cash is a failed page check',()=>refusal(o=>{o.values[0].value='20399999';}));
test('zero required duplicate links is a failed page check',()=>refusal(o=>{o.links[0].count=0;}));
test('cross-session cursor is a failed page check',()=>refusal(o=>{o.status=409;o.text='This view expired. Reload Morning View.';o.identity=null;}));
test('incomplete page showing a grand amount is a failed page check',()=>refusal(o=>{o.text='Incomplete — some balances unavailable';},
  {...expectation,scenario:'incomplete',texts:['Incomplete — some balances unavailable'],values:[],requiredLinks:[],noGrand:true}));
test('missing width is a failed page check',async()=>{
  const {assessMorningPage,finishMorningPageCheck,pageCheckExitCode}=await import('../scripts/check-morning-pages.mjs');
  assert.ok(assessMorningPage(expectation,valid(),{width:1280}).length);
  const result=finishMorningPageCheck([{id:'comparison',scenario:'comparison',width:390,problems:[]}],[expectation]);
  assert.ok(result.problems.some(p=>p.includes('1280')));assert.equal(pageCheckExitCode(result),1);
});
test('correct page, exact values, and both widths pass the validator',async()=>{
  const {assessMorningPage,pageCheckExitCode}=await import('../scripts/check-morning-pages.mjs');
  assert.deepEqual(assessMorningPage(expectation,valid(),{width:390}),[]);
  assert.equal(pageCheckExitCode({checked:24,problems:[]}),0);
});
test('sample refuses any database outside the supplied loopback harness database',async()=>{
  const {seedMorningScenario}=await import('../scripts/morning-sample.mjs');let queried=false;
  for(const url of ['postgres://postgres@127.0.0.1:5499/postgres','postgres://postgres@remote.example:5499/fb_test_0123456789ab'])
    await assert.rejects(seedMorningScenario({url,pool:{query:async()=>{queried=true;}}},{scenario:'first-look',clock:{now:()=>new Date()}}),/harness database/);
  assert.equal(queried,false);
});
test('deterministic scenarios reset and have exact financial facts before browser checks',async t=>{
  const {seedMorningScenario}=await import('../scripts/morning-sample.mjs');
  const db=await freshDb();t.after(()=>db.drop());let instant;
  const clock={now:()=>new Date(instant),set:n=>{instant=+new Date(n);}};
  const env={NODE_ENV:'test',DATABASE_URL:db.url,APP_ORG:'sample',DEV_NO_AUTH:'1'};
  for(const scenario of ['first-look','comparison','incomplete']){
    const {ids}=await seedMorningScenario(db,{scenario,clock,env});
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM morning_visit')).rows[0].n,scenario==='first-look'?0:1);
    const {owner}=await mvReadyViewers(db.pool,{orgId:ids.orgId,second:false});
    const r=await createMorningService({env}).observeMorning(db.pool,{identity:owner,now:clock.now,render:async()=>''});
    assert.equal(r.status,'ok');assert.equal(r.model.attention.counts.bankLines,3);assert.equal(r.model.attention.counts.bills,2);
    assert.equal(r.model.firstLook,scenario==='first-look');
    if(scenario==='incomplete'){assert.equal(r.model.money.grand.cashCents,null);assert.equal(r.model.money.companies.find(c=>c.entityId===ids.companyB).cashCents,10000000);}
    else{assert.equal(r.model.money.grand.cashCents,20400000);assert.equal(r.model.money.grand.availableCents,19400000);}
    if(scenario==='comparison'){assert.equal(r.model.money.changes.availableChangeCents,-9600000);assert.equal(r.model.entries.totals.aboveCount,120);assert.equal(r.model.entries.totals.smallCount,60);assert.equal(r.model.attention.counts.duplicateGroups,1);}
    if(scenario==='first-look')assert.equal(r.model.attention.counts.duplicateGroups,0);
    assert.equal(r.model.dismissed.staleCount,1);
  }
});
