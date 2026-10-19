import { createHmac, timingSafeEqual } from 'node:crypto';

const kinds = new Set(['ctx','entries','transfers','account','attention','duplicate-members','duplicate-pairs','dismissed']);
const positive = n => Number.isSafeInteger(n) && n > 0;
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const keys = (o, expected) => object(o) && Object.keys(o).sort().join(',') === [...expected].sort().join(',');
const text = (s, max = 512) => typeof s === 'string' && s.length > 0 && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s);
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
const canonical = v => JSON.stringify(v, function(k, value) { return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value; });
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
function resourceValid(kind, r) {
  if (kind === 'ctx' || kind === 'entries' || kind === 'transfers') return r === null;
  if (kind === 'account') return keys(r,['accountId']) && positive(r.accountId);
  if (kind === 'attention') return keys(r,['rule']) && typeof r.rule === 'string' && /^(all|bank|bill|invoice|tax|tax-coverage|floor|new-payee|large|alerts|duplicate|freshness)$/.test(r.rule)
    || keys(r,['rule','sourceKey']) && r.rule === 'limitations' && text(r.sourceKey);
  if (kind.startsWith('duplicate-')) return keys(r,['groupKey']) && text(r.groupKey);
  return kind === 'dismissed' && keys(r,['fold']) && ['matching','stale'].includes(r.fold);
}
function afterValid(kind, r, a) {
  if (a === null) return true;
  if (kind === 'ctx') return false;
  if (kind === 'transfers') {
    const leg = l => keys(l,['entityId','txnId','accountId']) && [l.entityId,l.txnId,l.accountId].every(positive);
    return keys(a,['lo','hi','out','in']) && leg(a.out) && leg(a.in)
      && a.lo === Math.min(a.out.txnId,a.in.txnId) && a.hi === Math.max(a.out.txnId,a.in.txnId);
  }
  if (kind === 'attention' && r.rule === 'freshness') return keys(a,['entityId','source','sourceKey']) && positive(a.entityId) && ['feed','import','none'].includes(a.source) && text(a.sourceKey);
  if (kind === 'attention' && r.rule === 'limitations') return keys(a,['entityId','llAccountId','kind']) && positive(a.entityId) && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.llAccountId) && ['no_account_success_evidence','historical_mapping'].includes(a.kind);
  if (kind === 'account' || kind === 'entries') return keys(a,['date','entityId','txnId','accountId']) && date(a.date) && [a.entityId,a.txnId,a.accountId].every(positive) && (kind !== 'account' || a.accountId === r.accountId);
  if (kind === 'duplicate-members') return keys(a,['date','txnId']) && date(a.date) && positive(a.txnId);
  if (kind === 'duplicate-pairs') return keys(a,['lo','hi']) && positive(a.lo) && positive(a.hi) && a.lo < a.hi;
  if (kind === 'dismissed' && r.fold === 'stale') return keys(a,['dismissedAt','itemKey']) && text(a.dismissedAt,40) && Number.isFinite(Date.parse(a.dismissedAt)) && text(a.itemKey);
  return keys(a,['severity','due','companySort','itemKey']) && Number.isInteger(a.severity) && a.severity >= 0 && a.severity <= 5 && (a.due === null || date(a.due)) && text(a.companySort,200) && text(a.itemKey);
}
function valid(p) {
  return keys(p,['sid','vk','epoch','gen','kind','resource','after','iat']) && text(p.sid,256) && typeof p.vk === 'string' && /^(owner|[1-9][0-9]{0,18})$/.test(p.vk)
    && positive(p.epoch) && (p.gen === null || uuid(p.gen)) && kinds.has(p.kind) && Number.isSafeInteger(p.iat) && p.iat >= 0
    && resourceValid(p.kind,p.resource) && afterValid(p.kind,p.resource,p.after);
}
export function makeCursor(secret, { sid, vk, epoch, gen, kind, resource, after = null, iat, ...unknown }) {
  const p = { sid,vk,epoch,gen,kind,resource,after,iat };
  if (Object.keys(unknown).length || !valid(p)) throw new Error('Invalid Morning View cursor');
  const body = Buffer.from(canonical(p)).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function readCursor(secret, token, { sid, vk, epoch, expectedKind, expectedResource, now }) {
  const expired = { expired: true };
  if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return expired;
  try {
    const [body, signature] = token.split('.'), mac = createHmac('sha256',secret).update(body).digest(), supplied = Buffer.from(signature,'base64url');
    if (mac.length !== supplied.length || !timingSafeEqual(mac,supplied) || supplied.toString('base64url') !== signature) return expired;
    const p = JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if (!valid(p) || Buffer.from(canonical(p)).toString('base64url') !== body) return expired;
    const time = now instanceof Date ? now.getTime() : now;
    if (!Number.isSafeInteger(time) || time < p.iat || time - p.iat > 3600000 || p.sid !== sid || p.vk !== vk || p.epoch !== epoch || p.kind !== expectedKind || canonical(p.resource) !== canonical(expectedResource)) return expired;
    return p;
  } catch { return expired; }
}
