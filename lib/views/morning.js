import { html } from './html.js';
import { linkOf } from './accounts.js';
import { formatCents } from '../domain/money.js';
import { formatPhoenix } from '../data/morning/clock.js';
import { ENTRY_TEXT } from '../data/morning/entries.js';
import { daysBetween } from '../domain/dates.js';

const dollars = n => n == null ? 'Unavailable' : formatCents(Number(n));
const signed = n => n == null ? 'Unavailable' : `${n >= 0 ? '+' : '−'}${dollars(Math.abs(n))}`;
const count = n => n == null ? 'Unavailable' : Number(n).toLocaleString('en-US');
const sourceAmount = (n,currency) => formatCents(Number(n)).replace('$',`${currency} `);
const units = n => n == null ? 'unavailable' : n;
const liveText = 'Live list — edits may change later pages or move entries between pages. Reload from the beginning for a fresh view';
const scopeText = 'Includes accounts entering or leaving the supported accounts; this is not a cash movement.';
const companyName = (m,id) => m.money.companies.find(c=>c.entityId===id)?.name
  ?? m.money.changes?.companies.find(c=>c.entityId===id)?.before?.name ?? 'Organization';
const value = (key,n) => html`<span data-value="${key}" data-cents="${units(n)}">${dollars(n)}</span>`;
const labels = { bankLines:'Bank lines',bankAccounts:'Bank accounts',bills:'Bills',dueBills:'Due bills',awaitingBills:'Awaiting approval',
  overdueInvoices:'Overdue invoices',taxReminders:'Tax calendar reminders',taxCoverage:'Tax coverage notices',floors:'Balance floors',newPayees:'New payee',large:'Large transactions',duplicateGroups:'Duplicate groups' };
const sectionLabels = { money:'Balances',entries:'Recent entries',transfers:'Transfer suggestions',bank:'Bank review',bills:'Bills and invoices',tax:'Tax calendar',floors:'Balance floors',alerts:'Transaction alerts',duplicates:'Possible duplicates',dismissals:'Dismissals',freshness:'Source freshness' };
const coverageLabels = { profile_missing:'Tax profile not set up',return_period_missing:'Tax return period not set up',missing_household_period:'Estimated-date reminders not set up for this year',
  no_personal_household:'Personal books not identified',unsupported_edition:'Unsupported form edition',missing_period:'Tax return period is missing',invalid_period:'Missing or invalid tax period',unknown_rule:'Unknown deadline rule',
  disregarded_no_calendar:'No separate return calendar; see the owner’s return',holiday_year_uncovered:'Calendar year outside the holiday table' };

function action(model,links,{entityId,type,txnId,rule,display={}}) {
  const company=display.entityName??companyName(model,entityId);
  const destination=rule==='bank'?'Banking → '+(Number(display.warningCount)>0?'Changed':'Review')
    :rule==='bill'?'Bills':rule==='invoice'?'Invoices':rule==='tax'||rule==='tax-coverage'?'Tax':'Transactions';
  const target=rule==='bank'?`/banking?account=${encodeURIComponent(display.llAccountId)}&tab=${Number(display.warningCount)>0?'changed':'review'}`
    :rule==='tax'||rule==='tax-coverage'?`/tax/${entityId}/profile`:txnId?linkOf({type,txn_id:txnId}):null;
  const allowed=target&&links.can(target);
  return html`<p class="morning-action">${allowed&&entityId===links.entityId?html`<a href="${target}">${company} → ${destination}</a>`:html`${company} → ${destination}`}
    ${!allowed?html`<span>Action unavailable with your current access</span>`:''}</p>`;
}
function membership(row) {
  if(!row)return '';
  if(row.reason==='company_changed'||row.reason==='reclassified')return html`${row.before?.entityName} (${row.before?.entityId}), ${row.before?.type} → ${row.after?.entityName??'No longer supported'} (${row.after?.entityId??'—'}), ${row.after?.type??'—'}; reclassification, not a cash transfer`;
  if(row.change==='entered_scope')return 'Entered the supported account set';
  if(row.change==='left_scope')return 'No longer in the supported accounts';
  if(row.reason==='unavailable')return 'Comparison unavailable';
  return '';
}
function money(model,links) {
  const m=model.money,g=m.grand,changes=m.changes;
  const companies=[...m.companies];
  for(const c of changes?.companies??[])if(!companies.some(a=>a.entityId===c.entityId))companies.push({entityId:c.entityId,name:c.before.name,isPersonal:c.before.isPersonal,status:'ok',cashCents:0,cardsOwedCents:0,availableCents:0,accounts:[]});
  companies.sort((a,b)=>Number(a.isPersonal)-Number(b.isPersonal)||a.name.localeCompare(b.name)||a.entityId-b.entityId);
  return html`<section class="morning-money" aria-labelledby="morning-money-title"><h2 id="morning-money-title">Where the money is</h2>
    ${m.status==='complete'?html`<p class="morning-headline" data-grand="complete"><span data-value="cash" data-cents="${g.cashCents}">Cash ${dollars(g.cashCents)}</span> · <span data-value="available" data-cents="${g.availableCents}">available after cards ${dollars(g.availableCents)}</span>.</p>
      ${model.firstLook?html`<p>First look — changes start from now</p>`:html`<p>Available after cards ${changes?.availableChangeCents==null?'change unavailable':`${changes.availableChangeCents<0?'down':'up'} ${dollars(Math.abs(changes.availableChangeCents))}`} since the comparison look, ${formatPhoenix(new Date(model.comparison.capturedAt))}.</p>`}
      <p>Net posted today: cash ${signed(g.postedTodayCashCents)}; available after cards ${signed(g.postedTodayAvailableCents)}.</p>`
      :html`<p class="morning-notice" data-grand="incomplete">Incomplete — some balances unavailable</p>`}
    ${changes?.scopeChanged?html`<p>${scopeText}</p>`:''}
    <p>Available after cards is cash minus cards owed — an estimate, not a bank's available balance.</p>
    ${model.clockUnavailable?html`<p>Clock unavailable; the comparison has not advanced.</p>`:''}
    ${companies.map(c=>{const delta=changes?.companies.find(r=>r.entityId===c.entityId),rows=[...c.accounts];
      for(const r of changes?.rows??[])if(r.before?.entityId===c.entityId&&!rows.some(a=>a.accountId===r.accountId))rows.push({...r.before,historical:true});
      return html`<details data-company-id="${c.entityId}"><summary>${c.isPersonal?(m.personal?.count===1?'Personal':`Personal — ${c.name}`):c.name} · cash ${dollars(c.cashCents)} · cards owed ${dollars(c.cardsOwedCents)} · available ${dollars(c.availableCents)}</summary>
        ${delta?html`<p>Cash change ${signed(delta.cashDeltaCents)} · available after cards change ${signed(delta.availableDeltaCents)}</p>`:''}
        <table class="morning-accounts"><thead><tr><th>Account</th><th>Type</th><th>Balance</th><th>Change</th><th>Membership</th></tr></thead><tbody>
          ${rows.filter(a=>!a.hidden||changes?.rows.some(r=>r.accountId===a.accountId)).map(a=>{const r=changes?.rows.find(r=>r.accountId===a.accountId);return html`<tr data-account-id="${a.accountId}">
            <td data-label="Account"><a href="${links.url('account',{accountId:a.accountId})}">${a.name}</a></td><td data-label="Type">${a.type==='bank'?'Bank':'Credit card'}</td>
            <td data-label="Balance">${dollars(a.historical?null:a.type==='credit_card'&&a.signedCents!=null?-a.signedCents:a.signedCents)}</td>
            <td data-label="Change">${model.firstLook?'—':signed(r?r.availableDeltaCents:0)} available</td><td data-label="Membership">${membership(r)}</td></tr>`;})}</tbody></table></details>`;})}
    ${m.personal?.count===0?html`<p>Personal books not identified</p>`:m.personal?.count>1?html`<p>Multiple Personal households identified; review tax profile setup.</p>`:''}</section>`;
}
function transfers(model,links) {
  const t=model.transfers;
  if(!t)return html`<p>Transfer suggestions unavailable</p>`;
  const leg=l=>html`<a href="${links.url('account',{accountId:l.accountId})}">${companyName(model,l.entityId)} · ${model.money.vector?.accounts.find(a=>a.accountId===l.accountId)?.name??`Account ${l.accountId}`} · Entry ${l.txnId}</a>`;
  return html`<div class="morning-transfers"><h3>${ENTRY_TEXT.transfer}</h3>
    <p>Showing ${t.page.length} of ${count(t.count)} possible transfers${t.next?html`; <a href="${links.url('transfers',null,t.next)}">More possible transfers</a>`:''}</p>
    ${t.page.map(r=>html`<p data-transfer-out="${r.out.txnId}" data-transfer-in="${r.in.txnId}">${leg(r.out)} ↔ ${leg(r.in)}.</p>`)}
    <p>Both original entries remain in counts and totals; matching amounts and dates may be coincidence.</p>
    <a href="${links.url('transfers')}">All possible transfers</a></div>`;
}
function entries(model,links,{kind='entries',resource=null}={}) {
  const e=model.entries;if(!e)return html`<section><h2>${ENTRY_TEXT.heading}</h2><p>Recent entries unavailable (ref ${model.diagnostics.entries})</p></section>`;
  const t=e.totals;
  return html`<section class="morning-entries"><h2>${ENTRY_TEXT.heading}</h2><p>${ENTRY_TEXT.limitation}</p>
    ${model.firstLook?html`<p>First look — changes start from now</p>`:''}
    <p data-entry-count="${units(t.aboveCount)}">Showing ${e.page.length} of ${count(t.aboveCount)}${e.next?html`; <a href="${links.url(kind,resource,e.next)}">more entries</a>`:''}</p>
    <ul class="morning-list">${e.page.map(r=>html`<li data-entry-id="${r.txnId}" data-account-id="${r.accountId}"><strong>${r.entityName} · ${r.accountName}</strong>
      <p>${r.date} · ${r.kind==='added'?'Added':'Historical entry edited — the edit may not have changed money'} · ${r.type}</p>
      <p>Current amount ${dollars(r.netCents)} · available after cards effect ${signed(r.availableEffectCents)}${r.accountType==='credit_card'?html` · cards owed effect ${signed(r.cardOwedEffectCents)}`:''}</p>
      ${r.coverage!=='known'?html`<p>Amount unavailable — unsupported home currency</p>`:''}${action(model,links,r)}</li>`)}</ul>
    <p>Smaller entries — current entry amounts: ${count(t.smallCount)}; positive ${dollars(t.smallPositiveCents)}; negative ${dollars(t.smallNegativeCents)}; net ${signed(t.smallNetCents)}.</p>
    <p>Current entry amounts: bank inflows ${dollars(t.bankInCents)}; bank outflows ${dollars(t.bankOutCents)}; card charges ${dollars(t.cardChargesCents)}; card credits ${dollars(t.cardCreditsCents)}.</p>
    ${e.residual?html`<p>${ENTRY_TEXT.residual}</p>`:''}<a href="${links.url(kind,resource)}">All entries</a>
    ${transfers(model,links)}</section>`;
}
function item(model,item,{csrf,ctxToken,links,dismissed=false}) {
  const d=item.display,rule=item.rule;
  return html`<li class="morning-item" data-item-key="${item.itemKey}"><strong>${companyName(model,item.entityId)} · ${rule==='duplicate'?'Possible duplicate':rule==='new-payee'?'New payee':rule==='floor'?'Balance floor':rule==='tax-coverage'?'Tax coverage':rule}</strong>
    ${rule==='bill'||rule==='invoice'?html`<p>${d.partyName??''} · ${d.type} ${d.docNumber??''} · due ${d.due} · ${d.open==null?'Amount unavailable — unsupported home currency':dollars(d.open)}</p>
      <p>${d.dueReason?'Due for review':''} ${d.awaitingReason?'Awaiting approval':''}${rule==='invoice'?`Overdue invoice · ${daysBetween(d.due,model.today)} ${daysBetween(d.due,model.today)===1?'day':'days'} late`:''}</p>`:''}
    ${rule==='bank'?html`<p>${d.accountName} · ${count(d.needsReviewCount)} lines need review; ${count(d.newOnlyCount)} new; ${count(d.warningCount)} warnings.</p>
      <p>Source currency ${d.currency}: inflows ${sourceAmount(d.inflowCents,d.currency)}; outflows ${sourceAmount(d.outflowCents,d.currency)}; net ${sourceAmount(d.netCents,d.currency)}.</p>
      ${Number(d.changed)>0?html`<p>Changed by bank</p>`:''}${Number(d.removed)>0?html`<p>Removed by bank</p>`:''}${Number(d.books)>0?html`<p>Linked books entry changed/removed</p>`:''}
      ${Number(d.pendingCount)>0?html`<p>Pending at bank — not ready to add: ${count(d.pendingCount)}</p>`:''}
      ${Number(d.pendingWarningCount)>0?html`<p>Pending at bank — not ready to add; included in warnings above: ${count(d.pendingWarningCount)}</p>`:''}`:''}
    ${rule==='tax'||rule==='tax-coverage'?html`<p>${d.text??d.label??''} ${d.wording??''} ${d.due??''}</p><p>${d.extension??''} ${d.payment??''} ${d.statusNote??''}</p>${rule==='tax'?html`<p>Calendar reminder only.</p>`:''}`:''}
    ${rule==='floor'?html`<p>${d.accountName}: ${dollars(d.signedCents)} below floor ${dollars(d.floorCents)}</p>`:''}
    ${rule==='new-payee'||rule==='large'?html`<p>${d.partyName??d.partyKey} · ${d.date} · ${d.type} · current movement ${signed(d.mCents)}</p>
      ${d.kind==='historical_edit'?html`<p>Rule on an edited historical entry — the edit may not have changed money.</p>`:''}`:''}
    ${rule==='duplicate'?html`<p>${count(d.memberCount)} entries · ${count(d.pairCount)} qualifying pairs</p><p>${d.partyKey} · ${d.family} · ${dollars(d.amountCents)} · ${d.firstDate} through ${d.lastDate}</p>
      <a href="${links.url('duplicate-members',{groupKey:item.itemKey})}">View members</a> · <a href="${links.url('duplicate-pairs',{groupKey:item.itemKey})}">View pairs</a>`:''}
    ${!['floor','duplicate'].includes(rule)?action(model,links,{entityId:item.entityId,rule,display:d,type:d.type,txnId:d.txnId}):''}
    ${dismissed?html`<p>${item.note??''}</p><time>${item.dismissedAt??''}</time>`:html`<form method="post" action="/morning/dismiss"><input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="item_key" value="${item.itemKey}"><input type="hidden" name="item_version" value="${item.version}"><input type="hidden" name="ctx" value="${ctxToken}">
      <label>Note <input name="note" maxlength="500"></label><button>Dismiss</button></form>`}</li>`;
}
function attention(model,options,{resource={rule:'all'}}={}) {
  const a=model.attention,{links}=options;
  const skipped=[['missingParty','missing party identity'],['multipleParty','multiple party identities'],['conflictParty','conflicting party identities']]
    .map(([key,reason])=>({n:model.alerts?.coverage[key],reason})).filter(({n})=>n>0);
  return html`<section id="attention"><h2>What needs attention</h2>
    ${a.unavailable.map(name=>html`<p class="morning-notice">${sectionLabels[name]??'Section'} unavailable (ref ${model.diagnostics[name]})</p>`)}
    ${Object.keys(a.coverage.byKind).map(k=>html`<p class="morning-coverage">${coverageLabels[k]??'Tax calendar coverage unavailable'} (${count(a.coverage.byKind[k])})</p>`)}
    ${(model.bank?.coverage??[]).map(c=>html`<p>${companyName(model,c.entityId)}: bank coverage ${c.kind.replaceAll('_',' ')} (${count(c.accounts)} accounts)</p>`)}
    ${skipped.map(({n,reason})=>html`<p class="morning-coverage">Transaction alerts skipped ${count(n)} ${n===1?'transaction':'transactions'}: ${reason}.</p>`)}
    ${!model.coverageKnown?html`<p>Coverage is incomplete; these counts do not establish that nothing needs attention.</p>`:''}
    <dl class="morning-counts">${Object.entries(labels).map(([key,label])=>html`<div><dt>${label}</dt><dd data-count="${key}">${count(a.counts[key])}</dd></div>`)}</dl>
    ${['bill','invoice'].map(rule=>html`<p data-total="${rule}" data-cents="${units(a.totals[rule]?.openCents)}">${rule==='bill'?'Bills':'Overdue invoices'} total: ${dollars(a.totals[rule]?.openCents)}</p>`)}
    <nav class="morning-links">${[['all','All attention'],['bill','All bills'],['invoice','All invoices'],['bank','Bank review'],['tax','Tax reminders'],['tax-coverage','Tax coverage'],['floor','Balance floors'],['new-payee','New payee'],['large','Large transactions'],['duplicate','Duplicate groups']].map(([rule,label])=>html`<a href="${links.url('attention',{rule})}">${label}</a>`)}</nav>
    <ul class="morning-list">${a.page.map(r=>item(model,r,options))}</ul>${a.next?html`<a href="${links.url('attention',resource,a.next)}">More attention</a>`:''}
    <a href="/morning/dismissed">Dismissed (${count(model.dismissed.matchingCount)})</a></section>`;
}
function freshness(model,links) {
  const f=model.freshness;
  return html`<section><h2>Source freshness</h2>${!f?html`<p>Source freshness unavailable (ref ${model.diagnostics.freshness})</p>`:html`<ul>${f.page.map(r=>html`<li>${r.entityName}: ${r.label}${r.at?html` — ${formatPhoenix(new Date(r.at))}`:''}; ${r.scope}
    ${r.source==='import'&&r.ageMs!=null?html` (${Math.floor(r.ageMs/86400000)} elapsed days old)`:''}
    ${r.stale?html`<p>Source refresh older than two days</p>`:''}${r.limitationCount?html` <a href="${links.url('attention',{rule:'limitations',sourceKey:r.sourceKey})}">Account limitations (${count(r.limitationCount)})</a>`:''}</li>`)}</ul>
    ${f.next?html`<a href="${links.url('attention',{rule:'freshness'},f.next)}">More sources</a>`:''}`}</section>`;
}
const heading=model=>html`<h1>Morning View</h1><p>As of <time datetime="${new Date(model.capturedAt).toISOString()}">${formatPhoenix(new Date(model.capturedAt))}</time></p>`;
export function morningPage(model, options) {
  return html`<main class="morning" data-morning-page="summary">${heading(model)}${money(model,options.links)}${attention(model,options)}${entries(model,options.links)}${freshness(model,options.links)}<a href="/settings/morning">Settings</a></main>`;
}
export function morningDetailPage(model,options,{kind,resource}) {
  const {links}=options;let body;
  if(kind==='entries'||kind==='account') {
    const a=model.accountDetail;
    const balance=a=>a?.signedCents==null?null:a.type==='credit_card'?-a.signedCents:a.signedCents;
    body=html`${a?html`<h2>${a.name}</h2>${!a.current?html`<p>No longer in the supported accounts</p>`:''}<p>Current balance ${value('account-balance',balance(a.current))} · comparison balance ${dollars(balance(a.comparison))}</p>`:''}${entries(model,links,{kind,resource})}`;
  }else if(kind==='transfers')body=transfers(model,links);
  else if(kind.startsWith('duplicate-')){
    const d=model.detail;
    body=!d?html`<p>Possible duplicates unavailable (ref ${model.diagnostics.duplicates})</p>`:d.gone?html`<p>This group no longer exists.</p><a href="${links.url('attention',{rule:'duplicate'})}">Reload group summaries</a>`
      :html`<h2>Possible duplicate ${kind==='duplicate-pairs'?'pairs':'members'}</h2><p>${count(d.memberCount)} entries · ${count(d.pairCount)} qualifying pairs</p>
        <p>Showing ${kind==='duplicate-members'?d.members.length:d.pairs.length} of ${count(kind==='duplicate-members'?d.memberCount:d.pairCount)}</p>
        <ul class="morning-list">${kind==='duplicate-members'?d.members.map(r=>html`<li data-member-id="${r.txnId}">Entry ${r.txnId} · ${r.date} · ${r.type} · Current entry amount ${signed(r.mCents)}
          ${r.kind==='historical_edit'?html`<p>Historical entry edited — the edit may not have changed money.</p>`:r.kind==='added'?html`<p>Added</p>`:''}</li>`)
          :d.pairs.map(r=>html`<li data-pair-lo="${r.lo}" data-pair-hi="${r.hi}">Entry ${r.lo} ↔ entry ${r.hi}</li>`)}</ul>
        ${d.next?html`<a href="${links.url(kind,resource,d.next)}">${kind==='duplicate-pairs'?'More pairs':'More members'}</a>`:''}`;
  }else if(resource.rule==='freshness')body=freshness(model,links);
  else if(resource.rule==='limitations')body=html`<h2>Source account limitations</h2><ul>${model.detail?.page.map(r=>html`<li>${companyName(model,r.entityId)}: ${r.text}</li>`)}</ul>${model.detail?.next?html`<a href="${links.url(kind,resource,model.detail.next)}">More limitations</a>`:''}`;
  else body=attention(model,options,{resource});
  return html`<main class="morning" data-morning-page="${kind}">${heading(model)}<p>${liveText}</p><a href="${links.url(kind,resource)}">Reload from the beginning</a>${body}</main>`;
}
export function morningDismissedPage(model,options,{fold}) {
  const d=model.dismissed,{links,csrf}=options,other=fold==='matching'?'stale':'matching';
  return html`<main class="morning" data-morning-page="dismissed" data-matching-count="${units(d.matchingCount)}" data-stale-count="${units(d.staleCount)}">${heading(model)}<h2>Dismissed items</h2>
    <p>${liveText}</p><a href="${links.url('dismissed',{fold})}">Reload from the beginning</a>
    <h3>${fold==='stale'?'No longer in this view':'Currently dismissed'}</h3><p>Showing ${d.page.length} of ${count(fold==='stale'?d.staleCount:d.matchingCount)}</p>${!d.complete?html`<p>Results are incomplete; some sections are unavailable.</p>`:''}
    <ul class="morning-list">${d.page.map(r=>html`<li>${fold==='stale'?html`<p>${r.note??''}</p><time>${r.dismissedAt}</time>`:html`<ul>${item(model,r,{...options,dismissed:true})}</ul>`}
      <form method="post" action="/morning/undismiss"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="item_key" value="${r.itemKey}"><button>Remove</button></form></li>`)}</ul>
    ${d.next?html`<a href="${links.url('dismissed',{fold},d.next)}">More entries</a>`:''}
    <a href="${links.url('dismissed',{fold:other})}">${other==='stale'?'No longer in this view':'Currently dismissed'}</a></main>`;
}
