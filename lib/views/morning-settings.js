import { html } from './html.js';
import { csrfField,field,selectField,checkbox,errorBanner,postButton } from './forms.js';
import { centsToInput,formatCents } from '../domain/money.js';

export function morningSettingsPage({viewer,preference:p,floors,bankAccounts,owner,csrf,error=null}){
  return html`<div class="morning-settings"><h1>Morning View settings</h1>${errorBanner(error)}
    <form method="post" action="/settings/morning/preferences">${csrfField(csrf)}
      <h2>Your morning message</h2>${checkbox('Send my morning message','enabled',p.enabled)}
      ${field('Time in America/Phoenix','send_time',p.sendTime,{type:'time',required:true})}
      ${selectField('Channel','channel',[['sms','SMS'],['email','Email']],p.channel)}
      ${field('Mobile number','phone',p.phone,{type:'tel'})}${field('Email address','email',p.email,{type:'email'})}
      ${checkbox('Include amounts','include_amounts',p.includeAmounts)}
      <p>Amounts appear in the message body and may show in phone or email notifications.</p>
      <h2>Recent-entry detail threshold</h2>${field('Show current entry amounts of at least','detail_threshold',centsToInput(p.detailThresholdCents))}
      <button>Save your preferences</button>
    </form>
    <section><h2>Balance floors</h2>
      ${floors.map(f=>html`<div><h3>${f.entityName} — ${f.accountName}</h3>${f.active?html`
        <form method="post" action="/settings/morning/floors">${csrfField(csrf)}<input type="hidden" name="account_id" value="${f.accountId}">
          ${field('Balance floor; blank removes it','floor',centsToInput(f.floorCents))}<button>Save floor</button></form>`
        :html`<p>Saved floor inactive — this account is no longer a bank account</p><p>${formatCents(f.floorCents)}</p>`}</div>`)}
      ${bankAccounts.length?html`<form method="post" action="/settings/morning/floors">${csrfField(csrf)}
        ${selectField('Bank account','account_id',bankAccounts.map(a=>[a.accountId,`${a.entityName} — ${a.name}`]),'')}
        ${field('Balance floor','floor','')}<button>Save floor</button></form>`:html`<p>No bank accounts in these books.</p>`}
    </section>
    ${owner?html`<section><h2>Second viewer</h2>
      <p>${owner.secondViewer?`${owner.secondViewer.name}: ${owner.secondViewer.state==='ready'?'Ready':'Pending enrollment'}`:'No second viewer'}</p>
      <form method="post" action="/settings/morning/viewer">${csrfField(csrf)}<input type="hidden" name="action" value="grant">
        ${selectField('Person','user_id',owner.candidates.map(u=>[u.userId,`${u.name} — ${u.email}`]),'',{blank:'Choose a person'})}
        <button>${owner.secondViewer?'Replace second viewer':'Grant second viewer'}</button></form>
      ${owner.secondViewer?html`${postButton({action:'/settings/morning/viewer',csrf,label:'Reset enrollment',extra:{action:'reset',user_id:owner.secondViewer.userId}})}
        ${postButton({action:'/settings/morning/viewer',csrf,label:'Remove second viewer',extra:{action:'remove'}})}`:''}
    </section><section><h2>Large-transaction threshold by company</h2>
      ${owner.companies.map(c=>html`<form method="post" action="/settings/morning/company-threshold">${csrfField(csrf)}
        <input type="hidden" name="entity_id" value="${c.entityId}">${field(c.name,'threshold',centsToInput(c.largeThresholdCents))}<button>Save threshold</button></form>`)}
    </section><section><h2>Organization delivery</h2>
      <form method="post" action="/settings/morning/delivery">${csrfField(csrf)}${checkbox('Enable organization delivery','enabled',owner.delivery.enabled)}
        <p>App origin: ${owner.delivery.configuredOrigin??'Not configured'}</p><button>Save delivery settings</button></form>
    </section><section><h2>Message channels</h2>
      ${Object.values(owner.transports).map(source=>html`<div><h3>${source.channel==='sms'?'SMS':'Email'}</h3>
        <p>${source.approved?'Approved':'Unapproved'}${source.sending?'':' — not configured to send'}</p>
        <p>${source.channel==='sms'?source.display.phone??'No SMS sender':source.display.entityName??'No email company selected'}</p>
        <p>Configuration fingerprint: ${source.display.fingerprint}</p>
        ${source.sending?postButton({action:'/settings/morning/transport-approve',csrf,label:'Approve this channel',extra:{channel:source.channel,revision:source.row?.source_revision??1,fingerprint:source.fingerprint}}):''}
      </div>`)}
      <form method="post" action="/settings/morning/delivery">${csrfField(csrf)}<input type="hidden" name="action" value="select-email">
        ${selectField('Email company','email_entity_id',owner.companies.map(c=>[c.entityId,c.name]),owner.transports.email.row?.email_entity_id??'',{blank:'Choose a company'})}
        <button>Select email company</button></form>
    </section>`:''}</div>`;
}
