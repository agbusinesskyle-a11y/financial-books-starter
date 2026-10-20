import { HttpError } from './http.js';
import { html, raw } from '../../lib/views/html.js';
import { layout } from '../../lib/views/layout.js';
import { appNav } from '../../lib/views/nav.js';
import { getNav } from '../../lib/data/nav.js';
import { canAccess } from '../../lib/domain/roles.js';
import { matchMorningRoute } from '../../lib/domain/morning-paths.js';
import { sessionUser } from '../../lib/data/users.js';
import { getAccountingSettings } from '../../lib/data/accounting.js';
import { setDateFormat } from '../../lib/domain/dates.js';
import { setShowAccountNumbers } from '../../lib/views/accounts.js';
import { validateMorningIdentityIn, MorningAccessError } from '../../lib/data/morning/access.js';
import { withReadSnapshot } from '../../lib/data/morning/locks.js';
import { readCursor, makeCursor } from '../../lib/data/morning/cursor.js';
import { createMorningService } from '../../lib/data/morning.js';
import { morningPage, morningDetailPage, morningDismissedPage } from '../../lib/views/morning.js';
import { dismissItem,undismissItem } from '../../lib/data/morning/dismissals.js';
import { readVisit } from '../../lib/data/morning/observe.js';
import { ValidationError } from '../../lib/data/writes.js';
import { readMorningSettingsIn,savePreferences,saveFloor,saveCompanyThreshold,saveDeliverySettings } from '../../lib/data/morning/settings.js';
import { grantSecondViewer,ownerResetViewer,removeSecondViewer } from '../../lib/data/morning/identity.js';
import { configuredOrigin,selectEmailCompany,approveTransport,observeTransportOrigin } from '../../lib/data/morning/transport.js';
import { settingsKey } from '../../lib/secrets.js';
import { morningSettingsPage } from '../../lib/views/morning-settings.js';
import { inviteSentBody } from '../../lib/views/users.js';

export const FORBIDDEN_FIELDS = new Set(['org_id','org','viewer','viewer_key','owner','actor','as_user','session']);
export function morningCan(path, viewer, ordinaryCan) {
  const match = matchMorningRoute('GET',path.split(/[?#]/)[0]);
  return match ? !match.error && Boolean(viewer) && (!match.ownerOnly || viewer.isOwner) : ordinaryCan(path);
}
// Only server-rendered anchors are filtered; retain their labels when the destination is unavailable.
export function filterVisibleLinks(body, can) {
  return String(body).replace(/<a\b[^>]*\bhref="(\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    (anchor, href, label) => can(href.split(/[?#]/)[0]) ? anchor : label);
}
export async function renderMorningShell(tx, { identity, session, body, path, csrf }) {
  const viewer = await validateMorningIdentityIn(tx,{identity});
  const who = identity.owner ? { owner:true,userId:identity.userId,role:'admin',allCompanies:true } : await sessionUser(tx,{userId:identity.userId,version:identity.sessionVersion});
  const { rows } = await tx.query('SELECT entity_id,name,time_zone FROM entity WHERE org_id=$1 ORDER BY lower(name),entity_id',[identity.orgId]);
  const companies = who.owner || who.allCompanies ? rows : rows.filter(r=>who.companyIds.includes(r.entity_id));
  const copy = { ...session };
  if (!companies.length) return String(layout({title:'Morning View',bare:true,body:html`<nav><a href="/morning">Morning View</a> <a href="/settings/morning">Morning settings</a></nav>
    ${raw(filterVisibleLinks(body,p=>morningCan(p,viewer,()=>false)))}<form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button>Sign out</button></form>`}));
  const company = companies.find(r=>r.entity_id===copy.entityId) ?? companies.find(r=>r.entity_id===Math.min(...rows.map(r=>r.entity_id))) ?? companies[0];
  copy.entityId = company.entity_id;
  const acct = await getAccountingSettings(tx,{orgId:identity.orgId,entityId:copy.entityId});
  setDateFormat(acct.dateFormat);setShowAccountNumbers(acct.showAccountNumbers);
  const orgAdmin = who.owner || (who.role==='admin' && who.allCompanies);
  const can = p => morningCan(p,viewer,x=>canAccess(who.role,'GET',x) && (orgAdmin || !/^\/settings\/(users|companies)(\/|$)/.test(x)));
  const navData = await getNav(tx,{orgId:identity.orgId,entityId:copy.entityId,who,sequential:true});
  navData.bookmarks = navData.bookmarks.filter(b=>can(b.href.split(/[?#]/)[0]));
  const nav=appNav({...navData,role:who.role,can,path,search:'',title:'Morning View',csrf,entityName:company.name,entityId:copy.entityId,companies:companies.map(c=>({entityId:c.entity_id,name:c.name}))});
  let shell=String(layout({title:'Morning View',entityName:company.name,csrf,body:raw(filterVisibleLinks(body,can))}));
  for(const [mark,part] of [['nav-top',nav.top],['nav-rail',String(nav.rail)+String(nav.panel)],['nav-bottom',nav.bottom]])shell=shell.replace(new RegExp(`<!--fb:${mark}-->[^]*?<!--/fb:${mark}-->`),()=>String(part));
  return shell.replace('<body>','<body class="with-nav">');
}

export async function morningRoutes({ req,res,path,query,form,pool,identity,route,session,send,extra,cursorSecret,now,runtime,env=process.env,hooks={},who }) {
  for(const field of FORBIDDEN_FIELDS) if(Object.hasOwn(query,field))throw new HttpError(400,'Unexpected field.');
  if (form) for(const field of FORBIDDEN_FIELDS) if(form.has(field))throw new HttpError(400,'Unexpected field.');
  const service=createMorningService({runtime,env,deps:hooks.loaders??{}});
  const expired=()=>new HttpError(409,'This view expired. Reload Morning View.');
  const urlFor=(context,kind,resource,after=null)=>{
    const token=makeCursor(cursorSecret,{...context,kind,resource,after});
    const params=new URLSearchParams({c:token});
    if(kind==='account')return `/morning/accounts/${resource.accountId}?${params}`;
    if(kind==='transfers'){params.set('view','transfers');return `/morning/entries?${params}`;}
    if(kind.startsWith('duplicate-')){params.set('kind','duplicates');params.set('group',resource.groupKey);params.set('view',kind==='duplicate-pairs'?'pairs':'members');return `/morning/attention?${params}`;}
    if(kind==='attention'){params.set('rule',resource.rule);if(resource.sourceKey)params.set('source',resource.sourceKey);}
    if(kind==='dismissed')params.set('fold',resource.fold);
    return `/morning/${kind}?${params}`;
  };
  const viewOptions=(context)=>({csrf:session.csrf,ctxToken:makeCursor(cursorSecret,{...context,kind:'ctx',resource:null,after:null}),viewer:identity,
    links:{entityId:session.entityId,url:(kind,resource=null,after=null)=>urlFor(context,kind,resource,after),
      can:href=>(identity.owner||who?.allCompanies||who?.companyIds?.length>0)&&canAccess(identity.owner?'admin':who?.role,'GET',href.split(/[?#]/)[0])}});
  const shell=async(tx,body)=>{await hooks.beforeRender?.();return renderMorningShell(tx,{identity,session,body,path,csrf:session.csrf});};
  const sendResult=result=>{
    if(result.status==='denied')throw new MorningAccessError(result.reason);
    if(result.status==='expired')throw expired();
    if(result.status==='not_found')throw new HttpError(404,'Account not found');
    if(result.status!=='ok')throw new HttpError(503,'Morning View is busy; try again in a moment.');
    send(res,200,result.html,extra);return true;
  };
  if(['settings','preferences','floors','viewer','company-threshold','delivery','transport-approve'].includes(route.route)){
    const show=async(error=null,status=200)=>{
      await observeTransportOrigin(pool,{orgId:identity.orgId,identity,env});
      const output=await withReadSnapshot(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,runtime},async tx=>{
        const model=await readMorningSettingsIn(tx,{identity,env});
        return renderMorningShell(tx,{identity,session,body:morningSettingsPage({...model,csrf:session.csrf,error}),path,csrf:session.csrf});
      });send(res,status,output,extra);return true;
    };
    try{
      if(route.route==='settings')return await show();
      const actorCtx=identity,instant=now?now():new Date(),positive=value=>/^[1-9][0-9]*$/.test(String(value??''))&&Number.isSafeInteger(Number(value))?Number(value):null;
      if(route.route==='preferences')await savePreferences(pool,{actorCtx,fields:Object.fromEntries(form),now:instant});
      if(route.route==='floors')await saveFloor(pool,{actorCtx,accountId:positive(form.get('account_id')),floorText:form.get('floor'),now:instant});
      if(route.route==='company-threshold')await saveCompanyThreshold(pool,{actorCtx,entityId:positive(form.get('entity_id')),thresholdText:form.get('threshold')});
      if(route.route==='delivery'){
        if(form.get('action')==='select-email')await selectEmailCompany(pool,{actorCtx,entityId:positive(form.get('email_entity_id'))});
        else await saveDeliverySettings(pool,{actorCtx,enabled:form.get('enabled')==='1',env});
      }
      if(route.route==='transport-approve')await approveTransport(pool,{actorCtx,channel:form.get('channel'),revision:positive(form.get('revision')),fingerprint:form.get('fingerprint'),env});
      if(route.route==='viewer'){
        const action=form.get('action');
        if(!['grant','reset','remove'].includes(action))throw new ValidationError('Choose a viewer action.');
        if(action==='remove')await removeSecondViewer(pool,{actorCtx,orgId:identity.orgId});
        else{
          const userId=positive(form.get('user_id'));if(!userId)throw new ValidationError('Choose an active person in these books.');
          const issuance=await (action==='grant'?grantSecondViewer:ownerResetViewer)(pool,{actorCtx,orgId:identity.orgId,userId,key:settingsKey(env),now:instant});
          const output=await withReadSnapshot(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,runtime},async tx=>{
            const {rows:[user]}=await tx.query('SELECT user_id,name,email FROM app_user WHERE org_id=$1 AND user_id=$2',[identity.orgId,userId]);
            if(!user)throw new HttpError(409,'This person changed; reload the settings.');
            return renderMorningShell(tx,{identity,session,path,csrf:session.csrf,
              body:inviteSentBody({user,link:`${configuredOrigin(env)}/invite/${issuance.token}`,ownerCopyOnly:issuance.ownerCopyOnly})});
          });send(res,200,output,extra);return true;
        }
      }
      send(res,303,'',{...extra,Location:'/settings/morning'});return true;
    }catch(error){if(error instanceof ValidationError)return show(error.message,error.status??422);throw error;}
  }
  if(['dismiss','undismiss','dismissed'].includes(route.route)){
    try{
      if(route.route==='undismiss'){
        await undismissItem(pool,{identity,itemKey:form.get('item_key'),now,runtime});
        send(res,303,'',{...extra,Location:'/morning/dismissed'});return true;
      }
      const fold=query.fold??'matching';
      if(route.route==='dismissed'&&!['matching','stale'].includes(fold))throw new HttpError(400,'Invalid dismissed view.');
      const context=await withReadSnapshot(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,runtime},async(tx,{N,authority})=>{
        const instant=now?now():N,token=route.route==='dismiss'?form.get('ctx'):query.c;
        if(token){
          const parsed=readCursor(cursorSecret,token,{sid:identity.sessionId,vk:identity.viewerKey,epoch:authority.epoch,
            expectedKind:route.route==='dismiss'?'ctx':'dismissed',expectedResource:route.route==='dismiss'?null:{fold},now:instant});
          if(parsed.expired)throw new HttpError(409,'Reload Morning View and try again.');return parsed;
        }
        if(route.route==='dismiss')throw new HttpError(409,'Reload Morning View and try again.');
        const visit=await readVisit(tx,{orgId:identity.orgId,viewerKey:identity.viewerKey});
        return {sid:identity.sessionId,vk:identity.viewerKey,epoch:authority.epoch,gen:visit.comparisonId??null,
          kind:'dismissed',resource:{fold},after:null,iat:+instant};
      });
      if(route.route==='dismiss'){
        const result=await dismissItem(pool,{identity,itemKey:form.get('item_key'),itemVersion:form.get('item_version'),note:form.get('note')??'',context,now,runtime,service});
        if(result==='changed')throw new HttpError(409,'Item changed; review it again.');
        if(result==='not_dismissible')throw new HttpError(422,'This item cannot be dismissed.');
        if(result==='unavailable')throw new HttpError(503,'This section is unavailable. Try again.');
        send(res,303,'',{...extra,Location:'/morning#attention'});return true;
      }
      const result=await service.readMorningDetail(pool,{identity,context,pageRequest:{kind:'dismissed',resource:{fold}},now,runtime,
        render:async(tx,model)=>shell(tx,morningDismissedPage(model,viewOptions(context),{fold}))});
      return sendResult(result);
    }catch(error){if(error instanceof ValidationError)throw new HttpError(error.status??422,error.message);throw error;}
  }
  if(route.route==='page'){
    const result=await service.observeMorning(pool,{identity,now,runtime,render:async(tx,model,decision)=>{
      const authority=await validateMorningIdentityIn(tx,{identity});
      const context={sid:identity.sessionId,vk:identity.viewerKey,epoch:authority.epoch,gen:decision.comparisonId,
        kind:'ctx',resource:null,after:null,iat:+model.capturedAt};
      return shell(tx,morningPage(model,viewOptions(context)));
    }});
    return sendResult(result);
  }
  let kind=route.route,resource=null;
  if(kind==='entries'&&query.view){if(query.view!=='transfers')throw expired();kind='transfers';}
  if(kind==='account')resource={accountId:route.accountId};
  if(kind==='attention'){
    const selectors={bills:'bill',invoices:'invoice',bank:'bank',tax:'tax',alerts:'alerts',duplicates:'duplicate',freshness:'freshness',limitations:'limitations'};
    if(query.kind&&!Object.hasOwn(selectors,query.kind))throw expired();
    const rule=query.rule??selectors[query.kind]??'all';
    resource=rule==='limitations'?{rule,sourceKey:query.source}:{rule};
    if(query.group||query.view){
      if(query.kind!=='duplicates'||!query.group||!['members','pairs'].includes(query.view))throw expired();
      kind=`duplicate-${query.view}`;resource={groupKey:query.group};
    }
  }
  const context=await withReadSnapshot(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,runtime},async(tx,{authority,N})=>{
    const instant=now?now():N;
    if((kind.startsWith('duplicate-')||resource?.rule==='limitations')&&!query.c)throw expired();
    if(query.c){const parsed=readCursor(cursorSecret,query.c,{sid:identity.sessionId,vk:identity.viewerKey,epoch:authority.epoch,expectedKind:kind,expectedResource:resource,now:instant});if(parsed.expired)throw expired();return parsed;}
    // Direct detail links start a read-only context from the retained comparison.
    const visit=await readVisit(tx,{orgId:identity.orgId,viewerKey:identity.viewerKey});
    const result={sid:identity.sessionId,vk:identity.viewerKey,epoch:authority.epoch,gen:visit.comparisonId??null,kind,resource,after:null,iat:+instant};
    try{makeCursor(cursorSecret,result);}catch{throw expired();}return result;
  });
  try{
    const result=await service.readMorningDetail(pool,{identity,context,pageRequest:{kind,resource},now,runtime,
      render:async(tx,model)=>shell(tx,morningDetailPage(model,viewOptions(context),{kind,resource}))});
    return sendResult(result);
  }catch(error){if(error instanceof ValidationError)throw new HttpError(error.status??409,error.message);throw error;}
}
