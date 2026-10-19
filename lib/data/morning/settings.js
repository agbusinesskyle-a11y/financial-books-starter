import { withReadSnapshot,withSecurityWrite } from './locks.js';
import { validateMorningIdentityIn } from './access.js';
import { ProtectedIdentityError,secondViewer } from './identity.js';
import { ValidationError,lockEntity } from '../writes.js';
import { normalPhone } from '../../sms/twilio.js';
import { parseMoney,parseSignedMoney } from '../../domain/money.js';
import { transportSourceIn,observeTransportOrigin,observeTransportOriginIn,configuredOrigin,fingerprintOf } from './transport.js';
const fail=message=>{throw new ValidationError(message);};
const positive=id=>Number.isSafeInteger(id)&&id>0;
async function validate(tx,identity,ownerOnly=false){
  const authority=await validateMorningIdentityIn(tx,{identity});
  if(ownerOnly&&!authority.isOwner)throw new ProtectedIdentityError('Only the owner can change these settings.');
  return authority;
}
export async function readMorningSettingsIn(tx,{identity,env=process.env}){
  const authority=await validate(tx,identity),orgId=identity.orgId,viewerKey=identity.viewerKey;
  const {rows:[p]}=await tx.query('SELECT * FROM morning_preference WHERE org_id=$1 AND viewer_key=$2',[orgId,viewerKey]);
  const {rows:floors}=await tx.query(`SELECT f.account_id "accountId",e.name "entityName",a.name "accountName",f.floor_cents "floorCents",a.type='bank' active
    FROM morning_floor f JOIN account a USING(org_id,account_id) JOIN entity e ON e.org_id=a.org_id AND e.entity_id=a.entity_id
    WHERE f.org_id=$1 AND f.viewer_key=$2 ORDER BY e.name,a.name,a.account_id`,[orgId,viewerKey]);
  const {rows:bankAccounts}=await tx.query(`SELECT a.account_id "accountId",e.name "entityName",a.name FROM account a JOIN entity e USING(org_id,entity_id)
    WHERE a.org_id=$1 AND a.type='bank' ORDER BY e.name,a.name,a.account_id`,[orgId]);
  let owner=null;
  if(authority.isOwner){
    const second=await secondViewer(tx,{orgId});
    const {rows:candidates}=await tx.query('SELECT user_id "userId",name,email FROM app_user WHERE org_id=$1 AND active ORDER BY name,user_id',[orgId]);
    const {rows:companies}=await tx.query(`SELECT e.entity_id "entityId",e.name,coalesce(s.large_threshold_cents,1000000)::bigint "largeThresholdCents"
      FROM entity e LEFT JOIN morning_company_setting s USING(org_id,entity_id) WHERE e.org_id=$1 ORDER BY e.name,e.entity_id`,[orgId]);
    const {rows:[d]}=await tx.query('SELECT * FROM morning_delivery_setting WHERE org_id=$1',[orgId]);
    const transports={};for(const channel of ['sms','email'])transports[channel]=await transportSourceIn(tx,{orgId,channel,env});
    owner={secondViewer:second,candidates,companies,delivery:{enabled:d?.delivery_enabled??false,trustedOrigin:d?.trusted_origin??null,
      settingsVersion:d?.settings_version??1,configuredOrigin:configuredOrigin(env)||null},transports};
  }
  return {viewer:{key:viewerKey,isOwner:authority.isOwner},preference:{enabled:p.enabled,sendTime:`${String(Math.floor(p.send_minute/60)).padStart(2,'0')}:${String(p.send_minute%60).padStart(2,'0')}`,
    channel:p.channel,phone:p.phone,email:p.email,includeAmounts:p.include_amounts,detailThresholdCents:p.detail_threshold_cents,settingsVersion:p.settings_version},floors,bankAccounts,owner};
}
export async function getMorningSettings(pool,{identity,env=process.env,runtime}){
  await observeTransportOrigin(pool,{orgId:identity.orgId,identity,env});
  return withReadSnapshot(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,runtime},tx=>readMorningSettingsIn(tx,{identity,env}));
}
export async function savePreferences(pool,{actorCtx,fields:f,now=new Date()}){
  return withSecurityWrite(pool,{orgId:actorCtx.orgId},async tx=>{
    await validate(tx,actorCtx);
    if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(f.send_time??''))fail('Use a time like 06:30.');
    if(!['sms','email'].includes(f.channel))fail('Choose SMS or email.');
    const enabled=f.enabled==='1',phoneText=String(f.phone??'').trim(),emailText=String(f.email??'').trim();
    const phone=f.channel==='sms'&&phoneText?normalPhone(phoneText):null,email=f.channel==='email'&&emailText?emailText:null;
    if(f.channel==='sms'&&phoneText&&!phone)fail('Enter a mobile number like (602) 555-0100.');
    if(email&&(email.length>200||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))fail('Enter a valid email address.');
    const threshold=parseMoney(f.detail_threshold);if(threshold===null)fail('The detail threshold is an amount like 500.00.');
    if(enabled&&!phone&&!email)fail('Add a phone number or email first.');
    if(enabled){const {rows:[transport]}=await tx.query('SELECT * FROM morning_transport WHERE org_id=$1 AND channel=$2',[actorCtx.orgId,f.channel]);
      if(!transport||transport.suspended||transport.approved_revision!==transport.source_revision||!transport.approved_fingerprint)fail('Turn delivery on after the owner approves this channel.');}
    const [h,m]=f.send_time.split(':').map(Number);
    await tx.query(`UPDATE morning_preference SET enabled=$3,send_minute=$4,channel=$5,phone=$6,email=$7,include_amounts=$8,
      detail_threshold_cents=$9,settings_version=settings_version+1,updated_at=$10 WHERE org_id=$1 AND viewer_key=$2`,
    [actorCtx.orgId,actorCtx.viewerKey,enabled,h*60+m,f.channel,phone,email,f.include_amounts==='1',threshold,now]);
  });
}
export async function saveFloor(pool,{actorCtx,accountId,floorText,now=new Date()}){
  return withSecurityWrite(pool,{orgId:actorCtx.orgId},async tx=>{
    await validate(tx,actorCtx);const invalid=()=>fail('Choose a bank account in these books.');
    if(!positive(accountId))invalid();
    const {rows:[account]}=await tx.query('SELECT entity_id FROM account WHERE org_id=$1 AND account_id=$2',[actorCtx.orgId,accountId]);if(!account)invalid();
    await lockEntity(tx,actorCtx.orgId,account.entity_id);
    if(!(await tx.query("SELECT 1 FROM account WHERE org_id=$1 AND account_id=$2 AND type='bank'",[actorCtx.orgId,accountId])).rowCount)invalid();
    const blank=String(floorText??'').trim()==='',cents=blank?null:parseSignedMoney(floorText);
    if(!blank&&cents===null)fail('The balance floor is an amount like 500.00.');
    if(blank)await tx.query('DELETE FROM morning_floor WHERE org_id=$1 AND viewer_key=$2 AND account_id=$3',[actorCtx.orgId,actorCtx.viewerKey,accountId]);
    else await tx.query(`INSERT INTO morning_floor(org_id,viewer_key,account_id,floor_cents,updated_at) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(org_id,viewer_key,account_id) DO UPDATE SET floor_cents=excluded.floor_cents,updated_at=excluded.updated_at`,[actorCtx.orgId,actorCtx.viewerKey,accountId,cents,now]);
    await tx.query('UPDATE morning_preference SET settings_version=settings_version+1,updated_at=$3 WHERE org_id=$1 AND viewer_key=$2',[actorCtx.orgId,actorCtx.viewerKey,now]);
  });
}
export async function saveCompanyThreshold(pool,{actorCtx,entityId,thresholdText}){
  return withSecurityWrite(pool,{orgId:actorCtx.orgId},async tx=>{
    await validate(tx,actorCtx,true);if(!positive(entityId))fail('Choose a company in these books.');
    await lockEntity(tx,actorCtx.orgId,entityId);const cents=parseMoney(thresholdText);
    if(cents===null||cents<=0)fail('The large-transaction threshold must be greater than zero.');
    await tx.query(`INSERT INTO morning_company_setting(org_id,entity_id,large_threshold_cents) VALUES($1,$2,$3)
      ON CONFLICT(org_id,entity_id) DO UPDATE SET large_threshold_cents=excluded.large_threshold_cents,
      settings_version=morning_company_setting.settings_version+1,updated_at=now()`,[actorCtx.orgId,entityId,cents]);
  });
}
export async function saveDeliverySettings(pool,{actorCtx,enabled,env=process.env}){
  return withSecurityWrite(pool,{orgId:actorCtx.orgId},async tx=>{
    await validate(tx,actorCtx,true);let origin=configuredOrigin(env);
    if(!/^https?:\/\/[^/\s]+$/.test(origin)||env.NODE_ENV==='production'&&!origin.startsWith('https://'))origin=null;
    if(enabled&&!origin)fail('Set APP_BASE_URL first.');
    await observeTransportOriginIn(tx,{orgId:actorCtx.orgId,env});
    await tx.query('INSERT INTO morning_delivery_setting(org_id) VALUES($1) ON CONFLICT DO NOTHING',[actorCtx.orgId]);
    await tx.query(`UPDATE morning_delivery_setting SET delivery_enabled=$2,trusted_origin=$3,trusted_origin_fingerprint=$4,
      settings_version=settings_version+1,updated_at=now() WHERE org_id=$1`,[actorCtx.orgId,Boolean(enabled),origin,origin?fingerprintOf(origin):null]);
  });
}
