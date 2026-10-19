import { RULE_VERSIONS,findCurrentItem } from './items.js';
import { computeMorning,readMorningDetail,recomputeMorningItemStore } from '../morning.js';
import { withMorningComputation,processMorningRuntime,LockBusyError } from './locks.js';
import { MorningAccessError } from './access.js';
import { ValidationError } from '../writes.js';
export { RULE_VERSIONS,canonical,itemVersion,versionFacts } from './items.js';
const defaultService={computeMorning,readMorningDetail};
const capturedNow=(now,N)=>now===undefined?N:typeof now==='function'?now():now;
function validKey(itemKey){if(typeof itemKey!=='string'||!itemKey.length||itemKey.length>512||/[\u0000-\u001f\u007f]/.test(itemKey))throw new ValidationError('Invalid attention item.');}
function testHooks(hooks){if(process.env.NODE_ENV==='production'&&Object.keys(hooks).length)throw new Error('Test overrides are not allowed in production');return hooks;}
export async function dismissItem(pool,{identity,itemKey,itemVersion:posted,note='',context,now,runtime=processMorningRuntime,service=defaultService,hooks={}}){
  return withMorningComputation(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,purpose:'dismiss',runtime,hooks:testHooks(hooks)},async(tx,captured)=>{
    validKey(itemKey);const rule=itemKey.split(':')[0];
    if(!Object.hasOwn(RULE_VERSIONS,rule))return 'not_dismissible';
    if(typeof note!=='string')throw new ValidationError('Use a note of at most 500 characters.');
    const clean=note.trim();if([...clean].length>500)throw new ValidationError('Use a note of at most 500 characters.');
    const N=capturedNow(now,captured.N);
    const {store}=await recomputeMorningItemStore(tx,{identity,authority:captured.authority,context,N,service});
    // Absence proves a change only when that rule was successfully computed.
    if(!store.ruleAvailable(rule))return 'unavailable';
    const current=await findCurrentItem(tx,{store,itemKey});
    if(!current||current.version!==posted)return 'changed';
    await tx.query(`INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version,note,dismissed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(org_id,viewer_key,item_key) DO UPDATE SET
      item_version=excluded.item_version,rule_version=excluded.rule_version,note=excluded.note,dismissed_at=excluded.dismissed_at`,
    [identity.orgId,identity.viewerKey,itemKey,current.version,RULE_VERSIONS[rule],clean||null,N]);
    return 'dismissed';
  });
}
export async function undismissItem(pool,{identity,itemKey,now,runtime=processMorningRuntime,hooks={}}){
  return withMorningComputation(pool,{identity,orgId:identity.orgId,viewerKey:identity.viewerKey,purpose:'undismiss',runtime,hooks:testHooks(hooks)},async tx=>{
    validKey(itemKey);
    return (await tx.query('DELETE FROM morning_dismissal WHERE org_id=$1 AND viewer_key=$2 AND item_key=$3',[identity.orgId,identity.viewerKey,itemKey])).rowCount>0;
  });
}
export async function dismissedItems(pool,{identity,context,fold,after=null,now,runtime=processMorningRuntime,service=defaultService}){
  if(!['matching','stale'].includes(fold))throw new ValidationError('Invalid dismissed view.');
  const result=await service.readMorningDetail(pool,{identity,context,pageRequest:{kind:'dismissed',resource:{fold},after},now,runtime,render:async()=>''});
  if(result.status==='denied')throw new MorningAccessError(result.reason);
  if(result.status==='busy')throw new LockBusyError();
  if(result.status!=='ok')throw Object.assign(new ValidationError('Reload Morning View and try again.'),{status:409});
  return result.model.dismissed;
}
