import { randomBytes,createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { lockEntity } from '../data/writes.js';
import { SCOPES,refuse } from './policy.js';

export async function mintTokenTx(tx,{orgId,entityId,name,source,scopes,actor}) {
  if (typeof name!=='string'||!name.trim()||name.length>100||name!==name.trim() ||
      typeof source!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(source) ||
      !Array.isArray(scopes)||!scopes.length||new Set(scopes).size!==scopes.length||scopes.some(s=>!SCOPES.includes(s)))
    refuse(422,'invalid_token_settings','Invalid token name, namespace or scopes.');
  await tx.query("SELECT set_config('app.actor',$1,true)",[actor]);
  const secret=randomBytes(32),digest=createHash('sha256').update(secret).digest();
  const {rows:[row]}=await tx.query(`INSERT INTO api_token(org_id,entity_id,name,source,token_hash,scopes,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING token_id`,[orgId,entityId,name,source,digest,scopes,actor]);
  await tx.query('INSERT INTO integration_setting(org_id,entity_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[orgId,entityId]);
  return {tokenId:row.token_id,token:`fbi_v1.${row.token_id}.${secret.toString('base64url')}`};
}
export async function revokeTokenTx(tx,{orgId,entityId,tokenId,actor}) {
  await tx.query("SELECT set_config('app.actor',$1,true)",[actor]);
  const r=await tx.query(`UPDATE api_token SET revoked_at=coalesce(revoked_at,now()) WHERE org_id=$1 AND entity_id=$2 AND token_id=$3`,[orgId,entityId,tokenId]);
  if (!r.rowCount) refuse(404,'token_not_found','Token not found.');
}
const locked=(pool,args,fn)=>withTransaction(pool,async tx=>{await lockEntity(tx,args.orgId,args.entityId);return fn(tx,args);});
export const mintToken=(pool,args)=>locked(pool,args,mintTokenTx);
export const revokeToken=(pool,args)=>locked(pool,args,revokeTokenTx);
