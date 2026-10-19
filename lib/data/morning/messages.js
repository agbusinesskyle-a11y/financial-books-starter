import { randomUUID } from 'node:crypto';
import { appOrg } from './access.js';
import { withSecurityRead,withSecurityWrite,withMorningComputation,morningJobAuthority,processMorningRuntime } from './locks.js';
import { phoenixDate,phoenixMinute,nextPhoenixMidnight,centsFromDb,absCents } from './clock.js';
import { readVisit,loadGeneration,pruneGenerations } from './observe.js';
import { computeMorning } from '../morning.js';
import { configuredOrigin,fingerprintOf,transportSourceIn,observeTransportOrigin,observeTransportOriginIn,buildAdapter } from './transport.js';
import { normalPhone } from '../../sms/twilio.js';
import { isPractice } from '../../domain/practice.js';
import { isDemo } from '../../domain/demo.js';
import { formatCents } from '../../domain/money.js';

const units=[['bankLines','bank line needs review','bank lines need review'],['bills','bill needs attention','bills need attention'],
  ['overdueInvoices','overdue invoice','overdue invoices'],['taxReminders','tax reminder','tax reminders'],
  ['floors','balance below its floor','balances below their floors'],['newPayees','new payee','new payees'],
  ['large','large transaction','large transactions'],['duplicateGroups','possible duplicate group','possible duplicate groups']];
export function composeMessage(model,{includeAmounts,origin}){
  const counts=model.attention.counts,parts=[],items=units.filter(([key])=>Number.isSafeInteger(counts[key])&&counts[key]>0)
    .map(([key,one,many])=>`${counts[key]} ${counts[key]===1?one:many}`);
  const unavailable=Boolean(model.attention.unavailable?.length)||units.some(([key])=>!Number.isSafeInteger(counts[key])||counts[key]<0);
  const known=model.complete&&model.coverageKnown&&!unavailable;
  if(items.length)parts.push(`${items.join(', ')}.`);
  if(!known)parts.push('Coverage is incomplete; review Morning View.');
  else if(!items.length&&!model.firstLook)parts.push('Nothing needs attention in the covered sections.');
  if(unavailable)parts.push('Some sections are unavailable.');
  if(model.attention.coverage?.known===false)parts.push('Tax calendar coverage is unknown.');
  if(model.firstLook)parts.push('Transaction alerts start after your first look.');
  const {money}=model;
  if(includeAmounts&&money.status==='complete'&&Number.isSafeInteger(money.grand.cashCents)&&Number.isSafeInteger(money.grand.availableCents)){
    parts.push(`Cash ${formatCents(money.grand.cashCents)}; available after cards ${formatCents(money.grand.availableCents)}.`);
    if(!model.firstLook){
      const changes=money.changes,baseline=+new Date(model.comparison?.capturedAt);
      if(model.comparison&&Number.isFinite(baseline)&&(!model.capturedAt||baseline<=+model.capturedAt)
        &&Number.isSafeInteger(changes?.cashChangeCents)&&Number.isSafeInteger(changes?.availableChangeCents)){
        const delta=n=>`${n===0?'unchanged':n>0?'up':'down'} ${formatCents(absCents(n))}`;
        parts.push(`Cash ${delta(changes.cashChangeCents)}; available after cards ${delta(changes.availableChangeCents)} since your last look.`);
      }else parts.push('Observation changes are unavailable.');
      if(changes?.scopeChanged)parts.push('Changes include accounts entering or leaving the supported set; they are not cash movements.');
    }
  }
  const smsText=`Morning View: ${parts.join(' ')} Open Morning View: ${origin}/morning`;
  return {subject:'Morning View is ready',emailText:`Morning View is ready\n\n${smsText}`,smsText};
}
export async function deliveryEligibility(db,{orgId,viewerKey,env=process.env}){
  const no=reason=>({ok:false,reason});if(isPractice(env))return no('practice');
  const {rows:[d]}=await db.query('SELECT * FROM morning_delivery_setting WHERE org_id=$1',[orgId]);
  if(!d?.delivery_enabled)return no('delivery_off');
  const {rows:[v]}=await db.query(`SELECT v.*,u.active,u.password_hash IS NOT NULL AS password_ready,u.totp_enc IS NOT NULL AS totp_ready
    FROM morning_viewer v LEFT JOIN app_user u ON u.org_id=v.org_id AND u.user_id=v.user_id WHERE v.org_id=$1 AND v.viewer_key=$2`,[orgId,viewerKey]);
  if(!v||v.enrollment_state!=='ready')return no('not_ready');
  if(viewerKey!=='owner'&&(!v.active||!v.password_ready||!v.totp_ready))return no('inactive');
  const {rows:[p]}=await db.query('SELECT * FROM morning_preference WHERE org_id=$1 AND viewer_key=$2',[orgId,viewerKey]);
  if(!p?.enabled)return no('prefs_off');if(p.membership_epoch!==v.membership_epoch)return no('not_ready');
  const contact=p.channel==='sms'?normalPhone(p.phone):p.email;
  if(!contact||(p.channel==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)))return no('no_contact');
  const origin=configuredOrigin(env);
  if(!/^https?:\/\/[^/\s]+$/.test(origin)||env.NODE_ENV==='production'&&!origin.startsWith('https://')
    ||d.trusted_origin!==origin||d.trusted_origin_fingerprint!==fingerprintOf(origin))return no('origin_mismatch');
  const source=await transportSourceIn(db,{orgId,channel:p.channel,env});
  if(!source.sending||!source.approved)return no('transport_unapproved');
  return {ok:true,versions:{epoch:v.membership_epoch,recipient:p.settings_version,delivery:d.settings_version,
    transportSource:source.row.source_revision,transportApproved:source.row.approved_revision,channel:p.channel},
    contact,includeAmounts:p.include_amounts,sendMinute:p.send_minute,fingerprint:source.fingerprint};
}
const versionFields=['epoch','recipient','delivery','transportSource','transportApproved','channel'];
const sameVersions=(a,b)=>versionFields.every(k=>a[k]===b[k]);
const rowVersions=r=>({epoch:r.membership_epoch,recipient:r.recipient_settings_version,delivery:r.delivery_settings_version,
  transportSource:r.transport_source_revision,transportApproved:r.transport_approved_revision,channel:r.channel});
const sameEligibility=(a,b)=>a.ok&&b.ok&&sameVersions(a.versions,b.versions)&&a.contact===b.contact&&a.includeAmounts===b.includeAmounts&&a.fingerprint===b.fingerprint;

// Daily keys survive every terminal outcome; recovery never obtains a dispatch capability.
export async function recoverClaims(tx,{orgId,N}){
  const {rows}=await tx.query(`UPDATE morning_message_claim SET state=CASE WHEN attempt_started_at IS NULL THEN 'skipped' ELSE 'unknown' END,
    completed_at=$2,outcome=CASE WHEN attempt_started_at IS NULL THEN 'unattempted claim recovered' ELSE 'attempt outcome unknown' END
    WHERE org_id=$1 AND state='claimed' AND claimed_at<$2::timestamptz-interval '15 minutes' RETURNING state`,[orgId,N]);
  await tx.query(`UPDATE morning_message_claim SET outcome=NULL,outcome_redacted_at=$2 WHERE org_id=$1 AND captured_at<$2::timestamptz-interval '90 days'
    AND outcome IS NOT NULL`,[orgId,N]);
  return {skipped:rows.filter(r=>r.state==='skipped').length,unknown:rows.filter(r=>r.state==='unknown').length};
}
export async function finishClaim(db,{orgId,claimId,state,outcome=null,N=new Date()}){
  if(!['sent','failed','unknown','skipped'].includes(state))throw new Error('Invalid terminal claim state');
  const {rows:[updated]}=await db.query(`UPDATE morning_message_claim SET state=$3,completed_at=$4,outcome=$5
    WHERE org_id=$1 AND claim_id=$2 AND state='claimed' RETURNING state`,[orgId,claimId,state,N,outcome?.slice(0,300)??null]);
  if(updated)return {updated:true,state:updated.state};
  const {rows:[current]}=await db.query('SELECT state FROM morning_message_claim WHERE org_id=$1 AND claim_id=$2',[orgId,claimId]);
  return {updated:false,state:current?.state??null};
}

// Selection precedes creation of a job capability, so it has its own short snapshot
// under SECURITY. Financial work subsequently uses the normal COMPUTE protocol.
async function snapshot(tx,fn,check=()=>{}){
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');let committed=false;
  try{check();const value=await fn();check();await tx.query('COMMIT');committed=true;return value;}
  finally{if(!committed)await tx.query('ROLLBACK');}
}
async function digestPrefs(tx,{orgId,viewerKey}){
  const {rows:[p]}=await tx.query(`SELECT p.detail_threshold_cents,
    coalesce((SELECT jsonb_agg(jsonb_build_array(account_id,floor_cents::text)) FROM morning_floor WHERE org_id=$1 AND viewer_key=$2),'[]') floors,
    coalesce((SELECT jsonb_agg(jsonb_build_array(entity_id,large_threshold_cents::text)) FROM morning_company_setting WHERE org_id=$1),'[]') thresholds
    FROM morning_preference p WHERE org_id=$1 AND viewer_key=$2`,[orgId,viewerKey]);
  return {detailThresholdCents:centsFromDb(p.detail_threshold_cents),floors:new Map(p.floors.map(([k,v])=>[k,centsFromDb(v)])),
    thresholds:new Map(p.thresholds.map(([k,v])=>[k,centsFromDb(v)]))};
}
export async function runMorningMessages({pool,env=process.env,clock={wall:()=>new Date(),mono:()=>performance.now()},log=()=>{},
  runtime=processMorningRuntime,testHooks={}}){
  if(isDemo(env))return {demo:true};
  if(env.NODE_ENV==='production'&&Object.keys(testHooks).length)throw new Error('Morning message test hooks are forbidden in production');
  if(testHooks.deadlineMs!==undefined&&(!Number.isFinite(testHooks.deadlineMs)||testHooks.deadlineMs<=0||testHooks.deadlineMs>30000))throw new Error('Invalid transport deadline');
  const summary={claimed:0,sent:0,failed:0,unknown:0,skipped:0};
  if(isPractice(env))return summary;
  const org=await appOrg(pool,env.APP_ORG||'sample');if(!org)return summary;const {orgId}=org;
  const hook=async(name,args)=>{
    try{await testHooks[name]?.(args);if(testHooks.crashAt===name)throw new Error(`Simulated morning crash: ${name}`);}
    catch(error){error.morningCrash=true;throw error;}
  };
  const viewers=await withSecurityWrite(pool,{orgId},async tx=>{
    await observeTransportOriginIn(tx,{orgId,env});
    const N=clock.wall(),recovered=await recoverClaims(tx,{orgId,N});summary.skipped+=recovered.skipped;summary.unknown+=recovered.unknown;
    await pruneGenerations(tx,{orgId,now:N});
    return (await tx.query("SELECT viewer_key FROM morning_viewer WHERE org_id=$1 AND enrollment_state='ready' ORDER BY viewer_key='owner' DESC,viewer_key",[orgId])).rows;
  });
  const ownedClaims=new WeakSet();
  const terminal=async(cap,state,outcome)=>{
    const r=await finishClaim(pool,{orgId,claimId:cap.row.claim_id,state,outcome,N:clock.wall()});if(r.updated)summary[state]++;return r;
  };
  for(const {viewer_key:viewerKey} of viewers){
    let cap;
    try{
      let end=Infinity;
      cap=await withSecurityRead(pool,{orgId,queryBudgetMs:()=>Math.min(5000,end-performance.now())},async tx=>{
        end=performance.now()+5000;const check=()=>{if(performance.now()>=end)throw new Error('Selection deadline');};
        return snapshot(tx,async()=>{
          const N=clock.wall(),m0=clock.mono(),eligibility=await deliveryEligibility(tx,{orgId,viewerKey,env});
          if(!eligibility.ok||phoenixMinute(N)<eligibility.sendMinute)return null;
          await hook('afterSelectionRead',{N,versions:{...eligibility.versions}});check();
          const v=eligibility.versions,{rows:[row]}=await tx.query(`INSERT INTO morning_message_claim
            (org_id,viewer_key,sent_on,claim_id,state,captured_at,claimed_at,membership_epoch,recipient_settings_version,delivery_settings_version,
             transport_source_revision,transport_approved_revision,channel)
            VALUES($1,$2,$3,$4,'claimed',$5,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(org_id,viewer_key,sent_on) DO NOTHING RETURNING *`,
          [orgId,viewerKey,phoenixDate(N),randomUUID(),N,v.epoch,v.recipient,v.delivery,v.transportSource,v.transportApproved,v.channel]);
          return row?{row,eligibility,expiryMono:m0+(nextPhoenixMidnight(N)-N)}:null;
        },check);
      });
    }catch(error){if(error.morningCrash)throw error;log('morning: selection unavailable');continue;}
    if(!cap)continue;ownedClaims.add(cap);summary.claimed++;
    const args={claimId:cap.row.claim_id};await hook('afterClaim',args);
    let payload;
    try{
      const v=cap.eligibility.versions,jobAuthority=morningJobAuthority({orgId,viewerKey,membershipEpoch:v.epoch,settingsVersion:v.recipient});
      payload=await withMorningComputation(pool,{orgId,viewerKey,jobAuthority,purpose:'digest',runtime},async tx=>{
        const N=clock.wall(),current=await deliveryEligibility(tx,{orgId,viewerKey,env});
        if(!sameEligibility(current,cap.eligibility))return null;
        const visit=await readVisit(tx,{orgId,viewerKey}),comparison=visit.latestId?await loadGeneration(tx,{orgId,viewerKey,generationId:visit.latestId}):null;
        if(visit.latestId&&!comparison)throw new Error('Digest baseline unavailable');
        const prefs=await digestPrefs(tx,{orgId,viewerKey}),model=await computeMorning(tx,{orgId,viewerKey,N,comparison,prefs,purpose:'digest',budget:tx});
        const message=composeMessage(model,{includeAmounts:current.includeAmounts,origin:configuredOrigin(env)});
        const {rowCount}=await tx.query(`UPDATE morning_message_claim SET baseline_generation_id=$3,baseline_captured_at=$4
          WHERE org_id=$1 AND claim_id=$2 AND state='claimed' AND attempt_started_at IS NULL`,[orgId,cap.row.claim_id,comparison?.generationId??null,comparison?.capturedAt??null]);
        return rowCount?{claimId:cap.row.claim_id,eligibility:current,message}:null;
      });
    }catch(error){
      await terminal(cap,error.message==='Morning job is no longer eligible'?'skipped':'failed',error.message==='Morning job is no longer eligible'?'eligibility changed':'computation unavailable');
      continue;
    }
    if(!payload){await terminal(cap,'skipped','eligibility changed');continue;}
    await hook('afterPrepare',args);
    let dispatch,providerStarted=false;
    try{
      await observeTransportOrigin(pool,{orgId,env});
      let end=Infinity;
      dispatch=await withSecurityRead(pool,{orgId,queryBudgetMs:()=>Math.min(5000,end-performance.now())},async tx=>{
        end=performance.now()+5000;const check=()=>{if(performance.now()>=end)throw new Error('Preflight deadline');};
        const prepared=await snapshot(tx,async()=>{
          if(!ownedClaims.has(cap)||payload.claimId!==cap.row.claim_id)return null;
          const {rows:[row]}=await tx.query('SELECT * FROM morning_message_claim WHERE org_id=$1 AND claim_id=$2',[orgId,cap.row.claim_id]);check();
          if(!row||row.state!=='claimed'||row.attempt_started_at||!sameVersions(rowVersions(row),cap.eligibility.versions))return null;
          const current=await deliveryEligibility(tx,{orgId,viewerKey,env});check();
          if(!sameEligibility(current,cap.eligibility)||!sameEligibility(current,payload.eligibility))return null;
          const adapter=await buildAdapter(tx,{orgId,channel:row.channel,claim:row,env,testHooks:{
            ...(testHooks.socketFactory?{socketFactory:testHooks.socketFactory}:{}),...(testHooks.fetchImpl?{fetchImpl:testHooks.fetchImpl}:{}),
            ...(testHooks.deadlineMs?{deadlineMs:testHooks.deadlineMs}:{})}});check();
          if(adapter.refused)return null;
          await hook('afterAdapterPrepared',args);check();
          const {rowCount}=await tx.query(`UPDATE morning_message_claim SET attempt_started_at=$3
            WHERE org_id=$1 AND claim_id=$2 AND state='claimed' AND attempt_started_at IS NULL`,[orgId,row.claim_id,clock.wall()]);
          return rowCount?{adapter,current}:null;
        },check);
        if(!prepared)return {state:'skipped',outcome:'eligibility changed'};
        await hook('afterAttemptCAS',args);await hook('beforeProvider',args);
        // This is the external-call boundary. No await may separate expiry/consent
        // checks from invoking the already prepared, pinned adapter.
        if(clock.mono()>=cap.expiryMono||phoenixDate(clock.wall())!==cap.row.sent_on)return {state:'skipped',outcome:'expired'};
        check();
        let result;
        providerStarted=true;
        try{result=await prepared.adapter.send({to:prepared.current.contact,subject:payload.message.subject,text:payload.message.emailText,body:payload.message.smsText});}
        catch{result={status:'unknown',detail:'provider outcome unknown'};}
        await hook('afterProvider',{...args,result});
        return {state:['sent','failed','unknown'].includes(result.status)?result.status:'skipped',outcome:result.detail??'transport did not send'};
      });
    }catch(error){if(error.morningCrash||providerStarted)throw error;dispatch={state:'skipped',outcome:'preflight unavailable'};}
    // The provider is closed and SECURITY is released before terminal diagnostics.
    // Failure here deliberately leaves claimed for recovery, never another attempt.
    await terminal(cap,dispatch.state,dispatch.outcome);
    ownedClaims.delete(cap);
  }
  return summary;
}
