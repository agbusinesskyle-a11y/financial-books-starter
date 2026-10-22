import { lockEntity } from '../data/writes.js';
import { withTransaction } from '../db.js';
import { isIsoDate } from '../domain/dates.js';

export const SCOPES = ['documents:write','bills:approve','payments:write','settlements:read'];
export class IntegrationError extends Error {
  constructor(status, code, message, field) {
    super(message); this.status=status; this.code=code;
    if (field) this.field=field;
  }
}
export const refuse = (status,code,message,field) => { throw new IntegrationError(status,code,message,field); };

export async function readIntegrationCompany(pool,identity) {
  const {rows}=await pool.query(`SELECT e.entity_id,e.name,s.instance_id,s.ledger_instance,s.write_floor,s.accept_writes
    FROM entity e JOIN integration_setting s ON s.org_id=e.org_id AND s.entity_id=e.entity_id WHERE e.org_id=$1 AND e.entity_id=$2`,[identity.orgId,identity.entityId]);
  return {companies:rows.map(r=>({...r,entity_id:String(r.entity_id)}))};
}

export async function saveIntegrationPolicyTx(tx,{orgId,entityId,acceptWrites=false,writeFloor=null,ledgerInstance='unconfigured',actor}) {
  if(typeof acceptWrites!=='boolean'||(writeFloor!==null&&!isIsoDate(writeFloor))||typeof ledgerInstance!=='string'||
    !ledgerInstance.trim()||ledgerInstance!==ledgerInstance.trim()||ledgerInstance.length>100||/[\x00-\x1f]/.test(ledgerInstance)||
    (acceptWrites&&(!writeFloor||ledgerInstance==='unconfigured')))refuse(422,'invalid_policy','Enabled writes require a date floor and a configured instance label.');
  await tx.query("SELECT set_config('app.actor',$1,true)",[actor]);
  await tx.query(`INSERT INTO integration_setting(org_id,entity_id,accept_writes,write_floor,ledger_instance,updated_by)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(org_id,entity_id) DO UPDATE SET accept_writes=$3,write_floor=$4,ledger_instance=$5,updated_by=$6,updated_at=now()`,
    [orgId,entityId,acceptWrites,writeFloor,ledgerInstance,actor]);
}
export const saveIntegrationPolicy=(pool,args)=>withTransaction(pool,async tx=>{
  await lockEntity(tx,args.orgId,args.entityId);return saveIntegrationPolicyTx(tx,args);
});

// Always entity before token, including when called by an already locked writer.
export async function assertWritePolicyTx(tx,identity,{txnDate,adoptOnly=false,requiredScope}) {
  await lockEntity(tx,identity.orgId,identity.entityId);
  const {rows:[token]}=await tx.query(`SELECT * FROM api_token WHERE token_id=$1 AND org_id=$2 AND entity_id=$3 FOR UPDATE`,
    [identity.tokenId,identity.orgId,identity.entityId]);
  if (!token || token.revoked_at || token.source!==identity.source) refuse(401,'invalid_token','Invalid integration token.');
  const required=Array.isArray(requiredScope)?requiredScope:[requiredScope];
  if (required.some(s=>!SCOPES.includes(s)||!token.scopes.includes(s))) refuse(403,'scope_required','Required integration scope is missing.');
  const {rows:[setting]}=await tx.query('SELECT * FROM integration_setting WHERE org_id=$1 AND entity_id=$2',[identity.orgId,identity.entityId]);
  if (!setting?.accept_writes || !setting.write_floor || setting.ledger_instance==='unconfigured') refuse(403,'writes_disabled','Integration writes are disabled.');
  if (!adoptOnly && txnDate<setting.write_floor) refuse(409,'date_floor','New accounting writes precede the integration date floor.');
  const actor=`Integration: ${token.name} [${token.token_id}]`;
  await tx.query("SELECT set_config('app.actor',$1,true)",[actor]);
  return {...setting,actor};
}
