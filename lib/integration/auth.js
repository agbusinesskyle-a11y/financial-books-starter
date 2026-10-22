import { createHash,timingSafeEqual } from 'node:crypto';
import { IntegrationError,refuse } from './policy.js';

const failures=new Map();
function admit(ip,now) {
  const key=String(ip??'unknown'),minute=Math.floor(now.getTime()/60000);
  let row=failures.get(key);
  if (!row||row.minute!==minute) {
    if (failures.size>=10000) failures.delete(failures.keys().next().value);
    row={minute,count:0};failures.set(key,row);
  }
  if (row.count>=30) {
    const error=new IntegrationError(429,'rate_limit','Too many authentication attempts.');
    error.retryAfter=60-Math.floor(now.getTime()/1000)%60;throw error;
  }
  // Reserve synchronously, before any await/query, so concurrent failures cannot all enter the pool.
  // Failed or unresolved lookups retain their slot until the minute changes; valid secrets release it.
  row.count++;
  return ()=>{row.count--;};
}
function invalid() {
  refuse(401,'invalid_token','Invalid integration token.');
}
export async function authenticateBearer(pool,{authorization,scope=null,entityId=null,now=new Date(),ip}) {
  const release=admit(ip,now);
  const match=typeof authorization==='string' && /^Bearer fbi_v1\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return invalid();
  const secret=Buffer.from(match[2],'base64url');
  if (secret.length!==32 || secret.toString('base64url')!==match[2]) return invalid();
  const {rows:[token]}=await pool.query('SELECT * FROM api_token WHERE token_id=$1',[match[1]]);
  const digest=createHash('sha256').update(secret).digest();
  if (!token||token.revoked_at||token.token_hash.length!==digest.length||!timingSafeEqual(token.token_hash,digest)) return invalid();
  release();
  const minute=new Date(Math.floor(now.getTime()/60000)*60000);
  const r=await pool.query(`UPDATE api_token SET
    rate_count=CASE WHEN rate_window=$2 THEN rate_count+1 ELSE 1 END,rate_window=$2,last_used_at=$3
    WHERE token_id=$1 AND revoked_at IS NULL AND (rate_window IS DISTINCT FROM $2 OR rate_count<120) RETURNING token_id`,
  [token.token_id,minute,now]);
  if (!r.rowCount) {
    const {rows:[fresh]}=await pool.query('SELECT revoked_at FROM api_token WHERE token_id=$1',[token.token_id]);
    if (!fresh||fresh.revoked_at) return invalid();
    const error=new IntegrationError(429,'rate_limit','Integration rate limit exceeded.');
    error.retryAfter=60-Math.floor(now.getTime()/1000)%60;throw error;
  }
  if (entityId!==null && String(entityId)!==String(token.entity_id)) refuse(403,'company_scope','Token belongs to another company.');
  if (scope && !token.scopes.includes(scope)) refuse(403,'scope_required','Required integration scope is missing.');
  return {tokenId:token.token_id,orgId:token.org_id,entityId:token.entity_id,source:token.source,scopes:token.scopes,
    actor:`Integration: ${token.name} [${token.token_id}]`};
}
