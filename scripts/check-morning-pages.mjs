import http from 'node:http';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb } from '../test/harness.js';
import { createApp } from '../services/app/index.js';
import { launchChrome, inspectPage, parsePathList } from './check-pages.mjs';
import { seedMorningScenario, assertHarnessDatabase, MORNING_SAMPLE_NOW } from './morning-sample.mjs';

export const pageCheckExitCode=result=>result.problems.length?1:0;
export function assessMorningPage(expected,page,{width}) {
  const problems=[];
  if(page.status!==(expected.status??200))problems.push(`document status ${page.status}, expected ${expected.status??200}`);
  if(page.pathname!==(expected.pathname??new URL(expected.path,'http://sample').pathname))problems.push(`wrong pathname ${page.pathname}`);
  if(page.title!==expected.title)problems.push(`wrong title ${page.title}`);
  if(page.heading!==expected.heading)problems.push(`wrong heading ${page.heading}`);
  if(expected.identity&&page.identity!==expected.identity)problems.push(`wrong page identity ${page.identity}`);
  if(/\/login(?:\/|$)|\/invite(?:\/|$)/.test(page.pathname)||/Sign in|Not found|Something went wrong|Not allowed/.test(page.title))problems.push('login/error page');
  if(page.inner!==width)problems.push(`missing width ${width}; browser reported ${page.inner} (${page.wide?.join(', ')??''})`);
  if(page.scroll>page.inner+1)problems.push(`page is ${page.scroll}px wide on a ${page.inner}px screen (${page.wide?.join(', ')??''})`);
  for(const text of expected.texts??[])if(!page.text.includes(text))problems.push(`missing text: ${text}`);
  for(const text of expected.notTexts??[])if(page.text.includes(text))problems.push(`unexpected text: ${text}`);
  for(const text of expected.htmlTexts??[])if(!page.html.includes(text))problems.push(`missing escaped HTML: ${text}`);
  for(const [i,spec] of (expected.values??[]).entries()){
    const actual=page.values?.[i];
    if(!actual||actual.count!==(spec.count??1))problems.push(`${spec.selector}: expected ${spec.count??1} elements, got ${actual?.count??0}`);
    if(Object.hasOwn(spec,'equals')&&String(actual?.value)!==String(spec.equals))problems.push(`${spec.selector}: expected ${spec.equals}, got ${actual?.value}`);
  }
  for(const [i,spec] of (expected.requiredLinks??[]).entries())if((page.links?.[i]?.count??0)<(spec.minLinks??1))problems.push(`missing required links: ${spec.selector}`);
  if(expected.noGrand&&page.grandCount!==0)problems.push('incomplete page shows grand amounts');
  if(expected.noCurrency&&/\$[\d,]+\.\d{2}/.test(page.text))problems.push('stale dismissal shows a historical amount');
  problems.push(...(page.errors??[]).map(e=>`browser error: ${e}`));
  return problems;
}
const required=['first-look','comparison','entries','entries-next','account','duplicate-members','duplicate-pairs','attention','dismissed','settings','incomplete'];
export function finishMorningPageCheck(checks,expectations) {
  const problems=checks.flatMap(c=>c.problems.map(p=>`${c.id} @${c.width}: ${p}`));
  for(const id of required)if(!expectations.some(e=>e.id===id))problems.push(`missing required state ${id}`);
  for(const e of expectations)for(const width of [390,1280])if(!checks.some(c=>c.id===e.id&&c.scenario===e.scenario&&c.width===width&&c.visited!==false))problems.push(`missing ${e.id} at width ${width}`);
  const checked=checks.filter(c=>c.visited!==false).length;
  if(checked<22)problems.push(`checked only ${checked} states; at least 22 required`);
  return {checked,problems};
}
const substitute=(value,ids)=>typeof value==='string'?value.replace(/\{\{([a-zA-Z]+)\}\}/g,(_,key)=>{if(!Object.hasOwn(ids,key))throw new Error(`Unknown sample ID ${key}`);return String(ids[key]);})
  :Array.isArray(value)?value.map(v=>substitute(v,ids)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,substitute(v,ids)])):value;
export async function runMorningPageCheck({db,app,clock,chrome,expectations}) {
  assertHarnessDatabase(db);
  if(app.env.DATABASE_URL!==db.url)throw new Error('Application must use the exact harness database');
  const origin=new URL(app.base);if(origin.hostname!=='127.0.0.1')throw new Error('Page checks require a loopback app');
  const checks=[];
  for(const domain of ['Page','Runtime','Log','Network'])await chrome.send(`${domain}.enable`);
  for(const width of [390,1280])for(const scenario of ['first-look','comparison','incomplete']){
    const {ids}=await seedMorningScenario(db,{scenario,clock,env:app.env});
    const rows=expectations.filter(e=>e.scenario===scenario).map(e=>substitute(e,ids)),discovered=new Map();
    for(const expected of rows){
      const check={id:expected.id,scenario,width,visited:false,problems:[]};checks.push(check);
      try{
        let path=expected.path;
        if(expected.selector){const links=discovered.get(`${expected.from}\n${expected.selector}`)??[];
          if(links.length<(expected.minLinks??1))throw new Error(`required selector matched ${links.length}: ${expected.selector}`);
          path=links[0];
        }
        const url=new URL(path,app.base);if(url.origin!==origin.origin)throw new Error('Discovered link left the sample app');
        const page=await inspectPage(chrome,{url:url.href,width,expected});check.visited=true;
        check.problems=assessMorningPage(expected,page,{width});
        const selectors=[...new Set(rows.filter(r=>r.from===expected.id&&r.selector).map(r=>r.selector))];
        if(selectors.length){const links=await chrome.evaluate(`Object.fromEntries(${JSON.stringify(selectors)}.map(selector=>[selector,[...document.querySelectorAll(selector)].map(a=>a.href)]))`);
          for(const selector of selectors)discovered.set(`${expected.id}\n${selector}`,links[selector]);}
      }catch(error){check.problems.push(error.message);}
    }
  }
  return finishMorningPageCheck(checks,expectations);
}

export async function morningPageCheckMain({negativeLogin=false}={}) {
  const db=await freshDb(),name=assertHarnessDatabase(db);let server,chrome,result;
  let instant=+MORNING_SAMPLE_NOW;const clock={now:()=>new Date(instant),set:n=>{instant=+new Date(n);}};
  const env={...process.env,DATABASE_URL:db.url,ALLOW_SUPERUSER:'1',APP_ORG:'sample',DEV_NO_AUTH:negativeLogin?'0':'1',NODE_ENV:'test',RUN_JOBS:'0',
    SETTINGS_KEY:'ab'.repeat(32),APP_BASE_URL:'http://127.0.0.1',APP_LOGIN_PASSWORD_HASH:bcrypt.hashSync('Sample test password',4),APP_TOTP_SECRET:'JBSWY3DPEHPK3PXP'};
  db.env=env;
  let cleanup={database:name,databaseAbsent:false,serverStopped:false,chromeStopped:false,profileRemoved:false};
  try{
    await seedMorningScenario(db,{scenario:'first-look',clock,env});
    server=http.createServer(createApp({pool:db.pool,env,now:clock.now}));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const base=`http://127.0.0.1:${server.address().port}`;
    chrome=await launchChrome({env});
    const expectations=parsePathList(await readFile(new URL('./check-pages-morning.txt',import.meta.url),'utf8'));
    result=await runMorningPageCheck({db,app:{base,env},clock,chrome,expectations});
  }catch(error){result={checked:0,problems:[error.message]};}
  finally{
    try{if(chrome)cleanup={...cleanup,...await chrome.close()};else cleanup.chromeStopped=true;}
    catch(error){(result??={checked:0,problems:[]}).problems.push(`Chrome cleanup: ${error.message}`);}
    try{if(server?.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));cleanup.serverStopped=!server?.listening;}
    catch(error){(result??={checked:0,problems:[]}).problems.push(`Server cleanup: ${error.message}`);}
    try{
      await db.drop();const adminUrl=new URL(db.url);adminUrl.pathname='/postgres';
      const admin=new pg.Client({connectionString:adminUrl.href});await admin.connect();
      try{cleanup.databaseAbsent=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount===0;}finally{await admin.end();}
      if(!cleanup.databaseAbsent)throw new Error('Exact created database still exists');
    }catch(error){(result??={checked:0,problems:[]}).problems.push(`Database cleanup: ${error.message}`);}
    console.log('cleanup '+JSON.stringify(cleanup));
  }
  console.log(`checked ${result.checked} Morning View states at 390px and 1280px`);
  console.log(result.problems.length?result.problems.join('\n'):'problems 0');
  return pageCheckExitCode(result);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.exitCode=await morningPageCheckMain({negativeLogin:process.argv.includes('--negative-login')});}
  catch(error){console.error(error.message);process.exitCode=1;}
}
