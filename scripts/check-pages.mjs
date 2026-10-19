// Authenticated page checks share one browser/cookie jar. Default report checks
// remain available: node scripts/check-pages.mjs [base-url] [path-list-file].
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORTS } from '../lib/reports/registry.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
export function parsePathList(text) {
  return text.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#')).map(line=>{
    if(line.startsWith('{'))return JSON.parse(line);
    const [path,...expect]=line.split('\t');return {path,texts:expect.length?[expect.join('\t')]:[]};
  });
}
export async function launchChrome({env=process.env,workspace=process.cwd()}={}) {
  const root=resolve(workspace),profile=await mkdtemp(resolve(root,'.page-check-chrome-'));
  if(!profile.startsWith(root+sep))throw new Error('Chrome profile must stay inside the workspace');
  const child=spawn(env.CHROME??'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--remote-debugging-port=0','--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu',
    '--disable-background-networking','--disable-component-update',`--crash-dumps-dir=${profile}`,`--user-data-dir=${profile}`,'about:blank'],
  {stdio:'ignore',env,windowsHide:true});
  let exited=false,startError,ws;
  const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  child.once('error',e=>{startError=e;});
  const waiting=new Map(),events=[];let serial=0,closed=false;
  const close=async()=>{
    if(closed)return {chromeStopped:exited,profileRemoved:true};closed=true;
    if(ws?.readyState===WebSocket.OPEN)try{await send('Browser.close');}catch{}
    if(!exited){await Promise.race([exit,sleep(2000)]);if(!exited){child.kill();await Promise.race([exit,sleep(5000)]);}}
    ws?.close();for(const pending of waiting.values()){clearTimeout(pending.timer);pending.reject(new Error('Chrome closed'));}waiting.clear();
    if(!profile.startsWith(root+sep))throw new Error('Unsafe Chrome cleanup path');
    await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    if(!exited&&!startError)throw new Error('Started Chrome process did not stop');
    return {chromeStopped:exited||Boolean(startError),profileRemoved:true};
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    if(ws?.readyState!==WebSocket.OPEN)return reject(new Error('Chrome is not connected'));
    const id=++serial,timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`Chrome timed out: ${method}`));},10000);
    waiting.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
  });
  try{
    let port;
    for(let i=0;i<100&&!port;i++){
      if(startError)throw startError;if(exited)throw new Error('Chrome exited before connecting');
      try{port=Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{}
      if(!port)await sleep(100);
    }
    if(!Number.isInteger(port)||port<1)throw new Error('Chrome did not expose its debugging port');
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target=targets.find(t=>t.type==='page');if(!target)throw new Error('Chrome page missing');
    ws=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    ws.addEventListener('message',e=>{
      const m=JSON.parse(e.data),pending=waiting.get(m.id);
      if(pending){clearTimeout(pending.timer);waiting.delete(m.id);m.error?pending.reject(new Error(m.error.message)):pending.resolve(m.result);}
      else if(m.method)events.push(m);
    });
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
    for(const domain of ['Page','Runtime','Log','Network'])await send(`${domain}.enable`);
    return {send,evaluate,events,close,pid:child.pid};
  }catch(error){await close();throw error;}
}

export async function inspectPage(chrome,{url,width,expected={}}) {
  await chrome.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  chrome.events.length=0;
  const navigation=await chrome.send('Page.navigate',{url});
  if(navigation.errorText)throw new Error(navigation.errorText);
  let document;
  for(let i=0;i<200;i++){
    const request=chrome.events.find(e=>e.method==='Network.requestWillBeSent'&&e.params.type==='Document'
      &&e.params.frameId===navigation.frameId&&e.params.loaderId===navigation.loaderId);
    document=request&&chrome.events.find(e=>e.method==='Network.responseReceived'&&e.params.type==='Document'
      &&e.params.frameId===navigation.frameId&&e.params.loaderId===navigation.loaderId&&e.params.requestId===request.params.requestId);
    if(document&&chrome.events.some(e=>e.method==='Page.loadEventFired'))break;
    await sleep(25);
  }
  if(!document)throw new Error('Missing main-frame document response for this navigation');
  const snapshot=await chrome.evaluate(`(async()=>{
    document.querySelectorAll('details').forEach(d=>{d.open=true;});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const expected=${JSON.stringify(expected)};
    const values=(expected.values??[]).map(spec=>{const nodes=[...document.querySelectorAll(spec.selector)],node=nodes[0];return {count:nodes.length,
      value:node?(spec.attribute?node.getAttribute(spec.attribute):spec.property?node[spec.property]:node.textContent.trim()):null};});
    return {pathname:location.pathname,title:document.title,heading:document.querySelector('h1')?.textContent.trim(),
      identity:document.querySelector('[data-morning-page]')?.getAttribute('data-morning-page')??null,
      text:document.body.innerText,html:document.body.innerHTML,inner:innerWidth,scroll:document.documentElement.scrollWidth,
      values,links:(expected.requiredLinks??[]).map(spec=>({count:document.querySelectorAll(spec.selector).length})),
      grandCount:document.querySelectorAll('[data-grand="complete"], [data-value="cash"][data-cents]:not([data-cents="unavailable"]), [data-value="available"][data-cents]:not([data-cents="unavailable"])').length,
      wide:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>${width}+1)
        .sort((a,b)=>b.scrollWidth-a.scrollWidth).slice(0,12)
        .map(e=>e.tagName+'.'+e.className+'[name='+e.getAttribute('name')+'] offsetWidth='+e.offsetWidth+' scrollWidth='+e.scrollWidth)};
  })()`);
  const errors=chrome.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Log.entryAdded'&&e.params.entry.level==='error'
    ||e.method==='Runtime.consoleAPICalled'&&e.params.type==='error').map(e=>e.params.exceptionDetails?.exception?.description??e.params.entry?.text??'Console error');
  return {...snapshot,status:document.params.response.status,requestId:document.params.requestId,loaderId:navigation.loaderId,errors};
}

async function defaultPaths(base) {
  const paths=['/reports','/reports/custom','/reports/management','/reports/r/kpi_scorecard','/reports/kpis/new','/reports/cash-flow','/reports/cash-flow?weeks=52&trend=1',
    ...['standard','profitability','cash_flow','balance_sheet','receivables','payables','revenue','sales'].map(d=>`/reports/dashboards?d=${d}`),
    ...REPORTS.map(r=>`/reports/r/${r.key}`),...REPORTS.filter(r=>['period','cashflow'].includes(r.kind)).map(r=>`/reports/r/${r.key}?run=1&period=this_year_to_date&columns=months&cmp_py=1&chg=1`),
    '/tax','/tax/all','/tax/parties'];
  try{
    const home=await (await fetch(base+'/tax/all')).text();
    const profiles=[...new Set([...home.matchAll(/href="(\/tax\/\d+\/profile)"/g)].map(m=>m[1]))];paths.push(...profiles);
    for(const path of profiles){const profile=await (await fetch(base+path)).text();
      for(const mapping of new Set([...profile.matchAll(/href="(\/tax\/\d+\/\d{4}\/mapping)"/g)].map(m=>m[1]))){paths.push(mapping,`${mapping}?show=all`);
        const editor=/href="(\/tax\/\d+\/\d{4}\/mapping\?source=\d+&amp;account=\d+)/.exec(await (await fetch(`${base}${mapping}?show=all`)).text());if(editor){const e=editor[1].replaceAll('&amp;','&');paths.push(e,`${e}&lines=1`);}}
      for(const sheet of new Set([...profile.matchAll(/href="(\/tax\/\d+\/\d{4})"/g)].map(m=>m[1]))){paths.push(sheet,...['manual','adjustments','cash','cogs'].map(s=>`${sheet}/${s}`));
        const drill=/href="(\/tax\/\d+\/\d{4}\?line=[^"#]+)/.exec(await (await fetch(base+sheet)).text());if(drill)paths.push(drill[1].replaceAll('&amp;','&'));}}
  }catch{ /* Navigation below reports a server that is unavailable. */ }
  return paths.map(path=>({path}));
}
export async function checkPagesMain() {
  const base=process.argv[2]??'http://127.0.0.1:3000',paths=process.argv[3]?parsePathList(await readFile(process.argv[3],'utf8')):await defaultPaths(base);
  const chrome=await launchChrome(),problems=[];let checked=0;
  try{for(const expected of paths)for(const width of [390,1280]){
    try{const page=await inspectPage(chrome,{url:new URL(expected.path,base).href,width,expected});
      if(page.scroll>page.inner+1)problems.push(`${expected.path} @${width}: page is ${page.scroll}px wide`);
      if(page.status!==200||/Not found|Something went wrong|Not allowed/.test(page.title))problems.push(`${expected.path} @${width}: ${page.status} ${page.title}`);
      for(const text of expected.texts??[])if(!page.text.includes(text))problems.push(`${expected.path} @${width}: missing ${text}`);
      problems.push(...page.errors.map(e=>`${expected.path} @${width}: ${e}`));checked++;
    }catch(error){problems.push(`${expected.path} @${width}: ${error.message}`);}
  }}finally{await chrome.close();}
  console.log(`checked ${checked} page views (${paths.length} pages × phone and desktop)`);
  console.log(problems.length?problems.join('\n'):'no problems');return problems.length?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.exitCode=await checkPagesMain();}catch(error){console.error(error.message);process.exitCode=1;}
}
