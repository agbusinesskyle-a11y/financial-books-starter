import { withSecurityWrite } from '../../lib/data/morning/locks.js';
import { validateActorIn } from '../../lib/data/morning/access.js';
import { lockEntity } from '../../lib/data/writes.js';
import { mintTokenTx,revokeTokenTx } from '../../lib/integration/tokens.js';
import { saveIntegrationPolicyTx,IntegrationError,refuse } from '../../lib/integration/policy.js';
import { integrationSettingsBody } from '../../lib/views/integration-settings.js';

export async function integrationSettingsRoutes(h) {
  const {path,req,res,pool,scope,identity,session,form,settingsPage,go}=h;
  if(path!=='/settings/integrations'&&!path.startsWith('/settings/integrations/'))return false;
  res.setHeader('Cache-Control','no-store');
  try {
    const result=await withSecurityWrite(pool,{orgId:scope.orgId,userIds:identity.userId?[identity.userId]:[]},async tx=>{
      const user=await validateActorIn(tx,identity);
      if(identity.orgId!==scope.orgId||(!identity.owner&&user?.role!=='admin'))refuse(403,'admin_required','Integration settings require an administrator.');
      if(!identity.owner&&user.all_companies===false) {
        const r=await tx.query('SELECT 1 FROM app_user_company WHERE user_id=$1 AND org_id=$2 AND entity_id=$3',[identity.userId,scope.orgId,scope.entityId]);
        if(!r.rowCount)refuse(403,'company_scope','Company access is no longer available.');
      }
      await lockEntity(tx,scope.orgId,scope.entityId);
      const actor=user?.name??h.actor,args={...scope,actor};
      let token=null,redirect=false;
      if(req.method==='POST') {
        const revoke=/^\/settings\/integrations\/tokens\/([1-9][0-9]{0,15})\/revoke$/.exec(path);
        const allowed=path==='/settings/integrations/tokens'?['csrf','name','source','scope']:
          path==='/settings/integrations/policy'?['csrf','accept_writes','write_floor','ledger_instance']:['csrf'];
        if([...form.keys()].some(k=>!allowed.includes(k)))refuse(422,'invalid_input','Unexpected settings field.');
        if(path==='/settings/integrations/tokens')token=(await mintTokenTx(tx,{...args,name:form.get('name'),source:form.get('source'),scopes:form.getAll('scope')})).token;
        else if(path==='/settings/integrations/policy') {
          await saveIntegrationPolicyTx(tx,{...args,acceptWrites:form.get('accept_writes')==='1',writeFloor:form.get('write_floor')||null,ledgerInstance:form.get('ledger_instance')});redirect=true;
        } else if(revoke) {await revokeTokenTx(tx,{...args,tokenId:Number(revoke[1])});redirect=true;}
        else refuse(404,'not_found','Integration settings route not found.');
      } else if(req.method!=='GET')refuse(405,'method_not_allowed','Method not allowed.');
      else if(path!=='/settings/integrations')refuse(404,'not_found','Integration settings route not found.');
      const setting=(await tx.query('SELECT accept_writes,write_floor,instance_id,ledger_instance FROM integration_setting WHERE org_id=$1 AND entity_id=$2',[scope.orgId,scope.entityId])).rows[0];
      const tokens=(await tx.query(`SELECT token_id,name,source,scopes,created_at,last_used_at,revoked_at FROM api_token WHERE org_id=$1 AND entity_id=$2 ORDER BY token_id`,[scope.orgId,scope.entityId])).rows;
      return {setting,tokens,token,redirect};
    });
    if(result.redirect)go('/settings/integrations');
    else settingsPage('integrations',integrationSettingsBody({csrf:session.csrf,...result}));
  } catch(error) {
    if(!(error instanceof IntegrationError))throw error;
    settingsPage('integrations',integrationSettingsBody({csrf:session.csrf,tokens:[],error:error.message}),error.status,null);
  }
  return true;
}
