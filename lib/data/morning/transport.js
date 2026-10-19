import { createHash } from 'node:crypto';
import { canonical } from './items.js';
import { ValidationError } from '../writes.js';
import { isPractice } from '../../domain/practice.js';
import { withSecurityWrite } from './locks.js';
import { validateMorningIdentityIn } from './access.js';
import { settingsKey,decryptSecret } from '../../secrets.js';
import { sendSms } from '../../sms/twilio.js';
import { sendBoundedSmtp } from '../../mail/bounded.js';

export const fingerprintOf = value => createHash('sha256').update(value).digest('hex');
export const configuredOrigin = env => String(env.APP_BASE_URL??'').trim().replace(/\/+$/,'');
// Caller holds SECURITY exclusive. No upgrade from a read snapshot is permitted.
export async function observeTransportOriginIn(tx,{orgId,env=process.env}){
  await tx.query(`INSERT INTO morning_delivery_setting(org_id,observed_origin_fingerprint) VALUES($1,$2)
    ON CONFLICT(org_id) DO UPDATE SET observed_origin_fingerprint=excluded.observed_origin_fingerprint,
      settings_version=morning_delivery_setting.settings_version+1,updated_at=now()
    WHERE morning_delivery_setting.observed_origin_fingerprint IS DISTINCT FROM excluded.observed_origin_fingerprint`,
  [orgId,fingerprintOf(configuredOrigin(env))]);
}
export async function observeTransportOrigin(pool,{orgId,identity,ownerOnly=false,env=process.env}){
  return withSecurityWrite(pool,{orgId},async tx=>{
    if(identity)await validateMorningIdentityIn(tx,{identity,ownerOnly});
    await observeTransportOriginIn(tx,{orgId,env});
  });
}
async function readSource(db,{orgId,channel,env=process.env}){
  if(!Number.isSafeInteger(orgId)||orgId<1||!['sms','email'].includes(channel))throw new ValidationError('Choose SMS or email.');
  const {rows:[row]}=await db.query(`SELECT t.*,d.observed_origin_fingerprint FROM morning_transport t
    JOIN morning_delivery_setting d USING(org_id) WHERE t.org_id=$1 AND t.channel=$2`,[orgId,channel]);
  const origin=configuredOrigin(env);let facts,display,configured,sending,settings;
  if(channel==='sms'){
    const {rows:[r]}=await db.query('SELECT * FROM sms_settings WHERE org_id=$1',[orgId]);
    settings=r;
    facts={channel,orgId,enabled:r?.enabled??false,accountSid:r?.account_sid??null,phone:r?.phone??null,credential:fingerprintOf(r?.auth_token_enc??''),origin};
    configured=Boolean(r?.account_sid&&r?.phone&&r?.auth_token_enc);sending=Boolean(configured&&r.enabled&&!isPractice(env));
    display={accountSid:facts.accountSid,phone:facts.phone,enabled:facts.enabled};
  }else{
    const {rows:[r]}=await db.query(`SELECT s.*,e.name entity_name FROM email_settings s JOIN entity e USING(org_id,entity_id)
      WHERE s.org_id=$1 AND s.entity_id=$2`,[orgId,row?.email_entity_id??null]);
    settings=r;
    facts={channel,orgId,entityId:row?.email_entity_id??null,mode:r?.mode??null,host:r?.smtp_host??null,port:r?.smtp_port??null,
      security:r?.smtp_security??null,user:r?.smtp_user??null,credential:fingerprintOf(r?.smtp_password_enc??''),
      fromName:r?.from_name??null,fromEmail:r?.from_email??null,replyTo:r?.reply_to??null,origin};
    configured=Boolean(r?.smtp_host&&r?.smtp_port&&r?.from_email);sending=Boolean(configured&&r.mode==='smtp'&&!isPractice(env));
    const {credential,...safe}=facts;display={...safe,entityName:r?.entity_name??null};
  }
  const fingerprint=fingerprintOf(canonical(facts));
  return {settings,channel,configured,sending,fingerprint,display:{...display,fingerprint:fingerprint.slice(0,12)},row:row??null,
    approved:Boolean(row&&row.observed_origin_fingerprint===fingerprintOf(origin)&&row.approved_revision===row.source_revision&&row.approved_fingerprint===fingerprint&&!row.suspended)};
}
export async function transportSourceIn(db,args){const {settings,...source}=await readSource(db,args);return source;}
export async function transportSource(pool,args){
  return withSecurityWrite(pool,{orgId:args.orgId},async tx=>{
    await observeTransportOriginIn(tx,args);
    return transportSourceIn(tx,args);
  });
}
async function advanceDelivery(tx,orgId){
  await tx.query('INSERT INTO morning_delivery_setting(org_id) VALUES($1) ON CONFLICT DO NOTHING',[orgId]);
  await tx.query('UPDATE morning_delivery_setting SET settings_version=settings_version+1,updated_at=now() WHERE org_id=$1',[orgId]);
}
export async function selectEmailCompany(pool,{actorCtx,entityId}){
  return withSecurityWrite(pool,{orgId:actorCtx.orgId},async tx=>{
    await validateMorningIdentityIn(tx,{identity:actorCtx,ownerOnly:true});
    if(!Number.isSafeInteger(entityId)||entityId<1||!(await tx.query('SELECT 1 FROM entity WHERE org_id=$1 AND entity_id=$2',[actorCtx.orgId,entityId])).rowCount)
      throw new ValidationError('Choose a company in these books.');
    await tx.query(`INSERT INTO morning_transport(org_id,channel,email_entity_id) VALUES($1,'email',$2)
      ON CONFLICT(org_id,channel) DO UPDATE SET email_entity_id=excluded.email_entity_id`,[actorCtx.orgId,entityId]);
    await advanceDelivery(tx,actorCtx.orgId);
  });
}
function checkHooks(env,hooks){if(env.NODE_ENV==='production'&&hooks&&Object.keys(hooks).length)throw new Error('Morning transport test hooks are forbidden in production');}
export async function approveTransport(pool,{actorCtx,channel,revision,fingerprint,env=process.env,hooks={}}){
  checkHooks(env,hooks);
  // Commit retirement even if the submitted approval subsequently proves stale.
  await observeTransportOrigin(pool,{orgId:actorCtx.orgId,identity:actorCtx,ownerOnly:true,env});
  return withSecurityWrite(pool,{orgId:actorCtx.orgId},async tx=>{
    await validateMorningIdentityIn(tx,{identity:actorCtx,ownerOnly:true});await hooks.afterSecurity?.();
    if(channel==='sms')await tx.query("INSERT INTO morning_transport(org_id,channel) VALUES($1,'sms') ON CONFLICT DO NOTHING",[actorCtx.orgId]);
    const s=await transportSourceIn(tx,{orgId:actorCtx.orgId,channel,env});
    if(!s.row||s.row.observed_origin_fingerprint!==fingerprintOf(configuredOrigin(env))||s.row.source_revision!==revision||s.fingerprint!==fingerprint||!s.sending)
      throw new ValidationError('These settings changed since the page was shown; review them again.');
    await tx.query(`UPDATE morning_transport SET approved_revision=source_revision,approved_fingerprint=$3,approved_at=now(),approved_by='owner',suspended=false
      WHERE org_id=$1 AND channel=$2`,[actorCtx.orgId,channel,fingerprint]);
    await advanceDelivery(tx,actorCtx.orgId);
  });
}
export async function buildAdapter(db,{orgId,channel,claim,env=process.env,testHooks={}}){
  checkHooks(env,testHooks);
  if(testHooks.deadlineMs!==undefined&&(!Number.isFinite(testHooks.deadlineMs)||testHooks.deadlineMs<=0||testHooks.deadlineMs>30000))throw new Error('Invalid transport deadline');
  const s=await readSource(db,{orgId,channel,env});
  if(!s.sending)return {refused:'not_sending'};
  if(!s.approved)return {refused:'unapproved'};
  if(s.row.source_revision!==claim.transport_source_revision||s.row.approved_revision!==claim.transport_approved_revision)return {refused:'changed'};
  const r=s.settings,key=settingsKey(env);let secret;
  try{secret=channel==='sms'?decryptSecret(key,r.auth_token_enc):r.smtp_password_enc?decryptSecret(key,r.smtp_password_enc):'';}catch{return {refused:'credentials'};}
  if(channel==='sms')return {send:({to,body})=>sendBoundedSms({accountSid:r.account_sid,authToken:secret,from:r.phone,to,body,
    fetchImpl:testHooks.fetchImpl,deadlineMs:testHooks.deadlineMs})};
  const from=r.from_name?`"${r.from_name.replace(/["\\]/g,'')}" <${r.from_email}>`:r.from_email;
  return {send:({to,subject,text})=>sendBoundedSmtp({host:r.smtp_host,port:r.smtp_port,security:r.smtp_security,user:r.smtp_user,password:secret,
    from,replyTo:r.reply_to,to,subject,text,socketFactory:testHooks.socketFactory,mono:testHooks.mono,deadlineMs:testHooks.deadlineMs})};
}
export async function sendBoundedSms({accountSid,authToken,from,to,body,deadlineMs=30000,fetchImpl=globalThis.fetch}){
  if(!Number.isFinite(deadlineMs)||deadlineMs<=0||deadlineMs>30000)throw new Error('Invalid SMS deadline');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadlineMs);let called=false;
  try{return {...await sendSms({accountSid,authToken,from,to,body,signal:controller.signal,fetchImpl:(...args)=>{called=true;return fetchImpl(...args);}}),detail:'SMS accepted the message'};}
  catch(error){return {status:error.httpStatus?'failed':called?'unknown':'failed',detail:error.httpStatus?`SMS refused the message (HTTP ${error.httpStatus})`:'SMS acceptance could not be established'};}
  finally{clearTimeout(timer);}
}
