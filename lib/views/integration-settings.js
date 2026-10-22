import { html } from './html.js';
import { csrfField,field } from './forms.js';
import { SCOPES } from '../integration/policy.js';

export function integrationSettingsBody({csrf,setting,tokens,token=null,error=null}) {
  const s=setting??{accept_writes:false,write_floor:null,ledger_instance:'unconfigured',instance_id:null};
  return html`${error?html`<p role="alert">${error}</p>`:''}
    ${token?html`<section class="card"><h2>Copy this token now</h2><p>It will not be shown again. Store it in your client's secret configuration.</p><code>${token}</code></section>`:''}
    <h2>Integration API</h2><p>Writes: <strong>${s.accept_writes?'enabled':'disabled'}</strong></p>
    <p>Instance: ${s.ledger_instance} · ${s.instance_id??'Not configured'}</p>
    <form method="post" action="/settings/integrations/policy">${csrfField(csrf)}
      <label><input type="checkbox" name="accept_writes" value="1" ${s.accept_writes?'checked':''}> Accept integration writes</label>
      ${field('Write floor','write_floor',s.write_floor??'',{type:'date'})}
      ${field('Instance label','ledger_instance',s.ledger_instance,{required:true})}<button>Save integration policy</button>
    </form><h2>Tokens</h2>
    <table><thead><tr><th>Name</th><th>Source</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Revoked</th><th></th></tr></thead><tbody>
    ${tokens.map(t=>html`<tr><td>${t.name}</td><td>${t.source}</td><td>${t.scopes.join(', ')}</td><td>${t.created_at?.toISOString()}</td>
      <td>${t.last_used_at?.toISOString()??'Never'}</td><td>${t.revoked_at?.toISOString()??'Active'}</td><td>${!t.revoked_at?html`
      <form method="post" action="/settings/integrations/tokens/${t.token_id}/revoke">${csrfField(csrf)}<button>Confirm revoke ${t.name}</button></form>`:''}</td></tr>`)}
    </tbody></table><h2>Create token</h2><form method="post" action="/settings/integrations/tokens">${csrfField(csrf)}
      ${field('Name','name','',{required:true})}${field('Source namespace','source','',{required:true})}
      <fieldset><legend>Scopes</legend>${SCOPES.map(s=>html`<label><input type="checkbox" name="scope" value="${s}"> ${s}</label>`)}</fieldset>
      <button>Create token</button></form>`;
}
