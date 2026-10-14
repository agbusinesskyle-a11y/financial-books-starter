import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatDateTime } from './format.js';
import { linkOf } from './accounts.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';

// Bank transactions (stage B3, QBO's Banking page): account cards across the top, For review / Categorized / Excluded tabs,
// and one page per bank item to match, add, transfer or exclude it.

const TABS = [['review', 'For review'], ['categorized', 'Categorized'], ['excluded', 'Excluded']];
const KIND = { bank: 'Bank', credit_card: 'Card', long_term_liability: 'Loan', other_current_liability: 'Liability' };
const spent = c => (Number(c) < 0 ? formatCents(-Number(c)) : '');
const received = c => (Number(c) > 0 ? formatCents(Number(c)) : '');
const txnLabel = t => `${TYPE_LABELS[t.type] ?? t.type}${t.doc_number ? ` ${t.doc_number}` : ''}`;

// The suggestion cell: a match, a rule, or what was done before.
const SURE = { high: 'Sure', medium: 'Likely', low: 'Maybe' };
export function suggestionText(s, accountNames) {
  if (!s) return html`<span class="muted">—</span>`;
  if (s.source === 'match') return html`<span class="tag ok">Match</span> ${txnLabel(s.txn)}${s.txn.party ? ` · ${s.txn.party}` : ''} · ${formatShortDate(s.txn.txn_date)}`;
  const what = accountNames.get(Number(s.accountId)) ?? '';
  if (s.source === 'ai') return html`<span class="tag">AI</span> ${s.research.business_name ?? ''}${what ? ` → ${what}` : ''}<small class="muted">Researched — open to accept</small>`;
  if (s.source === 'rule') return html`<span class="tag ok">Rule</span> ${what}<small class="muted">${s.rule.name}${s.rule.mode === 'auto' ? ' (adds automatically)' : ''}</small>`;
  return html`<span class="${s.confidence === 'high' ? 'tag ok' : 'tag'}">${SURE[s.confidence]}</span> ${what}<small class="muted">Like ${s.count} of ${s.of} earlier item${s.of === 1 ? '' : 's'}</small>`;
}

export function bankingPage({ entityName, csrf, flash, timeZone, accounts, current, tab, items, counts, suggestions, accountNames = new Map(), canRefresh, canReview, page, more }) {
  const q = (o = {}) => `/banking?${new URLSearchParams({ account: current?.id ?? '', tab, ...o })}`;
  return layout({ title: 'Bank transactions', entityName, csrf, flash, body: html`<div class="page-actions"><h1>Bank transactions</h1><span class="spacer"></span>
    ${canReview && accounts.length ? html`<a class="button" href="/banking/rules">Rules</a>` : ''}
    ${canRefresh && accounts.length ? postButton({ action: '/bank-feeds/refresh', csrf, label: 'Refresh', cls: '', extra: { back: q() } }) : ''}</div>
  ${!accounts.length ? html`<div class="card"><p>No bank or card accounts are connected yet.</p>
    <p class="muted">An admin links this company to ledgerline and matches its accounts in <a href="/settings/bank-feeds">Settings → Bank connections</a>.</p></div>` : html`
  <div class="bank-cards" role="list">${accounts.map(a => html`<a role="listitem" class="${a.id === current.id ? 'bank-card active' : 'bank-card'}" href="/banking?account=${a.id}"${a.id === current.id ? html` aria-current="page"` : ''}>
    <span class="bank-card-name">${a.books_name}</span><small class="muted">${KIND[a.books_type] ?? ''}${a.mask ? ` ••${a.mask}` : ''}</small>
    <span class="bank-card-row"><small>Bank</small><strong>${a.bank_balance_cents === null ? '—' : formatCents(Number(a.bank_balance_cents))}</strong></span>
    <span class="bank-card-row"><small>In books</small><strong>${formatCents(a.books_balance_cents)}</strong></span>
    <span class="bank-card-foot">${a.to_review ? html`<span class="tag">${a.to_review} to review</span>` : html`<span class="tag ok">All reviewed</span>`}
      ${a.verified_through ? html`<span class="tag ok" title="Ledgerline has checked this account against statements">Verified to ${formatShortDate(a.verified_through)}</span>` : ''}
      ${a.attention ? html`<span class="tag warn">${a.attention} changed at bank</span>` : ''}
      ${a.verified?.difference ? html`<span class="tag warn" title="Ledgerline proved this month against the bank statement">Books off by ${formatCents(a.verified.difference)} at ${formatShortDate(a.verified.periodEnd)}</span>` : ''}
      ${a.connection_state && a.connection_state !== 'healthy' ? html`<span class="tag warn">Connection: ${a.connection_state}</span>` : ''}</span>
  </a>`)}</div>
  ${current.balance_as_of ? html`<p class="muted small">Bank balance as of ${formatDateTime(current.balance_as_of, timeZone)}${current.balance_stale ? ' (older than a day and a half)' : ''}.</p>` : ''}
  <nav class="tabs" aria-label="Bank item tabs">${TABS.map(([k, label]) => html`<a class="${k === tab ? 'tab active' : 'tab'}" href="${q({ tab: k })}"${k === tab ? html` aria-current="page"` : ''}>${label} (${counts[k]})</a>`)}</nav>
  <form method="post" action="/banking/batch" class="bank-batch">${csrfField(csrf)}<input type="hidden" name="account" value="${current.id}"><input type="hidden" name="tab" value="${tab}">
    ${tab === 'review' && canReview && items.length ? html`<div class="page-actions"><span class="muted small">Tick items, or leave all unticked to accept every sure suggestion.</span><span class="spacer"></span>
      <button name="action" value="accept" class="primary">Accept suggestions</button><button name="action" value="exclude">Exclude ticked</button></div>` : ''}
    ${items.length ? html`<div class="table-scroll"><table class="grid bank-items">
      <thead><tr>${tab === 'review' && canReview ? html`<th class="pick"><span class="visually-hidden">Tick</span></th>` : ''}<th>Date</th><th>Bank description</th><th>${tab === 'review' ? 'Suggestion' : 'Recorded as'}</th>
        <th class="num">Spent</th><th class="num">Received</th><th class="actions"></th></tr></thead>
      <tbody>${items.map(i => {
        const s = suggestions.get(Number(i.item_id));
        return html`<tr class="${i.pending ? 'pending' : ''}">
        ${tab === 'review' && canReview ? html`<td class="pick">${i.pending ? '' : html`<input type="checkbox" name="item" value="${i.item_id}" aria-label="Tick ${i.description}">`}</td>` : ''}
        <td>${formatShortDate(i.posted_date)}</td>
        <td><a href="/banking/item/${i.item_id}">${i.description || '(no description)'}</a>${i.merchant_name ? html`<small class="muted">${i.merchant_name}</small>` : ''}
          ${i.pending ? html`<small class="muted">Pending at the bank</small>` : ''}${i.attention ? html`<small class="warn">${i.attention === 'removed' ? 'Removed by the bank — check it' : 'Changed by the bank — check it'}</small>` : ''}</td>
        <td>${tab === 'review' ? suggestionText(s, accountNames)
          : i.review_state === 'excluded' ? html`<span class="muted">Excluded</span>`
          : html`${i.links.map((l, n) => html`${n ? ', ' : ''}${l.how === 'matched' ? 'Matched to ' : 'Added: '}<a href="${linkOf(l)}">${txnLabel(l)}</a>${l.party ? ` · ${l.party}` : ''}`)}${i.rule_name ? html`<small class="muted">Added by rule ${i.rule_name}</small>` : ''}`}</td>
        <td class="num">${spent(i.amount_cents)}</td><td class="num">${received(i.amount_cents)}</td>
        <td class="actions">${i.pending ? '' : html`<a href="/banking/item/${i.item_id}">${tab === 'review' ? 'Review' : 'View'}</a>`}</td>
      </tr>`;
      })}</tbody></table></div>
      ${page > 1 || more ? html`<p class="pager">${page > 1 ? html`<a href="${q({ page: page - 1 })}">‹ Newer</a>` : ''} ${more ? html`<a href="${q({ page: page + 1 })}">Older ›</a>` : ''}</p>` : ''}`
    : html`<p class="muted">${tab === 'review' ? 'Nothing to review on this account.' : tab === 'categorized' ? 'Nothing categorized yet.' : 'Nothing excluded.'}</p>`}
  </form>`}` });
}

// One bank item: what the bank says, and (if it's waiting) the four things you can do with it.
export function bankItemPage({ entityName, csrf, flash, item, candidates, suggested, suggestion = null, vendors, customers, categories, transferTo, links, error = null, v: typed = null, canReview,
  research = null, ai = null, prefill = null }) {
  // The Add form starts from the rule or history suggestion.
  const v = typed ?? prefill ?? (suggestion && suggestion.source !== 'match' ? { payee: suggestion.payee ?? '', memo: suggestion.memo ?? '', lines: [{ accountId: suggestion.accountId ?? '' }] } : {});
  const out = Number(item.amount_cents) < 0;
  const back = `/banking?account=${item.ll_account}&tab=${item.review_state === 'new' ? 'review' : item.review_state === 'excluded' ? 'excluded' : 'categorized'}`;
  const waiting = item.review_state === 'new' && item.bank_state === 'active' && !item.pending;
  const payees = out && item.books_type !== 'credit_card' && item.books_type !== 'bank' ? [...vendors, ...customers]
    : out ? vendors : item.books_type === 'bank' ? customers : [...vendors, ...customers];
  const line = n => html`<div class="split-line">
    <label class="field"><span>${n ? `Category ${n + 1}` : 'Category'}</span><select name="line_account"${n ? '' : html` required`}><option value="">${n ? '—' : 'Choose…'}</option>
      ${categories.map(([group, list]) => html`<optgroup label="${group}">${list.map(a => html`<option value="${a.account_id}"${String(v.lines?.[n]?.accountId ?? '') === String(a.account_id) ? html` selected` : ''}>${a.name}</option>`)}</optgroup>`)}</select></label>
    <label class="field"><span>Amount</span><input name="line_amount" inputmode="decimal" value="${v.lines?.[n]?.amount ?? ''}" placeholder="${n ? '' : (Math.abs(item.amount_cents) / 100).toFixed(2)}"></label>
    <label class="field"><span>Description</span><input name="line_description" value="${v.lines?.[n]?.description ?? ''}"></label></div>`;
  return layout({ title: 'Bank item', entityName, csrf, flash, body: html`<div class="crumbs"><a href="${back}">‹ Bank transactions</a></div>
  <h1>${item.description || 'Bank item'}</h1>${errorBanner(error)}
  <div class="card bank-item-facts"><dl class="facts">
    <dt>Account</dt><dd>${item.books_name}</dd>
    <dt>Date</dt><dd>${formatShortDate(item.posted_date)}${item.authorized_date && item.authorized_date !== item.posted_date ? html` <small class="muted">(authorized ${formatShortDate(item.authorized_date)})</small>` : ''}</dd>
    <dt>${out ? 'Spent' : 'Received'}</dt><dd><strong>${formatCents(Math.abs(Number(item.amount_cents)))}</strong></dd>
    ${item.merchant_name ? html`<dt>Merchant</dt><dd>${item.merchant_name}</dd>` : ''}
    ${item.check_number ? html`<dt>Check</dt><dd>${item.check_number}</dd>` : ''}
    ${item.category ? html`<dt>Bank’s category</dt><dd>${item.category.replaceAll('_', ' ').toLowerCase()}</dd>` : ''}
    <dt>Status</dt><dd>${item.pending ? 'Pending at the bank — it can be added once it posts.' : item.bank_state === 'removed' ? 'Removed by the bank.'
      : item.review_state === 'new' ? 'For review' : item.review_state === 'excluded' ? 'Excluded' : `${item.review_state === 'matched' ? 'Matched' : 'Added'} by ${item.reviewed_by ?? '—'}`}</dd>
  </dl>
  ${links.length ? html`<p>${links.map((l, n) => html`${n ? html`<br>` : ''}${l.how === 'matched' ? 'Matched to' : l.how === 'grouped' ? 'Deposit made from waiting payments:' : 'Added as'} <a href="${linkOf(l)}">${txnLabel(l)}</a>${l.party ? ` · ${l.party}` : ''} · ${formatShortDate(l.txn_date)}`)}</p>` : ''}
  ${item.attention ? html`<p class="warn">${item.attention === 'removed' ? 'The bank removed this item after it was recorded. Check the books transaction, then undo if it shouldn’t be there.' : 'The bank changed this item’s amount or date after it was recorded. Check the books transaction.'}</p>` : ''}
  ${canReview && item.review_state !== 'new' ? postButton({ action: `/banking/item/${item.item_id}/undo`, csrf, label: 'Undo', cls: '',
    confirm: item.review_state === 'excluded' ? null : links.some(l => l.how !== 'matched') ? 'Undo? The transaction added from this bank item is deleted.' : 'Undo the match? The books transaction stays.' }) : ''}
  </div>
  ${waiting && canReview ? html`
  <section class="card"><h2>Match</h2>
    ${candidates.exact.length || candidates.others.length || candidates.undeposited.length ? html`<form method="post" action="/banking/item/${item.item_id}/match">${csrfField(csrf)}
      <p class="muted small">Tick what this bank item is. Together they must come to ${formatCents(Math.abs(Number(item.amount_cents)))}.</p>
      <ul class="check-list">${candidates.exact.map(c => html`<li><label class="check"><input type="checkbox" name="txn" value="${c.txn_id}"${suggested && suggested.txn_id === c.txn_id ? html` checked` : ''}>
        ${txnLabel(c)}${c.party ? ` · ${c.party}` : ''} · ${formatShortDate(c.txn_date)} · ${formatCents(Math.abs(Number(c.amount_cents)))}${suggested && suggested.txn_id === c.txn_id ? html` <span class="tag ok">Suggested</span>` : ''}</label> <a href="${linkOf(c)}" class="small">View</a></li>`)}
      ${candidates.others.length ? html`<li class="muted small">Or several that together make ${formatCents(Math.abs(Number(item.amount_cents)))}:</li>` : ''}
      ${candidates.others.map(c => html`<li><label class="check"><input type="checkbox" name="txn" value="${c.txn_id}">
        ${txnLabel(c)}${c.party ? ` · ${c.party}` : ''} · ${formatShortDate(c.txn_date)} · ${formatCents(Math.abs(Number(c.amount_cents)))}</label> <a href="${linkOf(c)}" class="small">View</a></li>`)}
      ${candidates.undeposited.map(u => html`<li><label class="check"><input type="checkbox" name="waiting" value="${u.txn_id}">
        ${TYPE_LABELS[u.type] ?? u.type}${u.doc_number ? ` ${u.doc_number}` : ''}${u.customer_name ? ` · ${u.customer_name}` : ''} · ${formatShortDate(u.txn_date)} · ${formatCents(Number(u.total_cents))} <small class="muted">waiting to be deposited</small></label></li>`)}</ul>
      <div class="form-actions"><button class="primary">Match</button></div></form>`
    : html`<p class="muted">Nothing in the books has this amount on ${item.books_name} near this date.</p>`}
  </section>
  ${researchCard({ csrf, item, research, ai })}
  <form method="post" action="/banking/item/${item.item_id}/add" class="card editor">${csrfField(csrf)}
    <h2>Add</h2>
    ${!typed && suggestion?.source === 'rule' ? html`<p class="tag ok">Filled in by rule “${suggestion.rule.name}”</p>`
      : !typed && prefill ? html`<p class="tag">Filled in from the research — check it, then Add</p>`
      : !typed && suggestion?.source === 'ai' ? html`<p class="tag">Filled in from AI research on this payee — check it</p>`
      : !typed && suggestion?.source === 'history' ? html`<p class="${suggestion.confidence === 'high' ? 'tag ok' : 'tag'}">Filled in like ${suggestion.count} of ${suggestion.of} earlier item${suggestion.of === 1 ? '' : 's'} with this description</p>` : ''}
    <p class="muted small">Records ${out ? (item.books_type === 'bank' ? (item.check_number ? `check ${item.check_number}` : 'an expense') : item.books_type === 'credit_card' ? 'a card expense' : 'a journal entry')
      : item.books_type === 'bank' ? 'a deposit' : 'a journal entry'} on ${item.books_name} dated ${formatShortDate(item.posted_date)}. Split it across categories by filling more lines.</p>
    <label class="field"><span>Payee</span><select name="payee"><option value="">(none)</option>
      ${payees.map(p => html`<option value="${p.key}"${v.payee === p.key ? html` selected` : ''}>${p.name}</option>`)}</select></label>
    ${[0, 1, 2].map(line)}
    <label class="field"><span>Memo</span><input name="memo" value="${v.memo ?? ''}" placeholder="${item.description}"></label>
    <div class="form-actions"><button class="primary">Add</button><a href="/banking/rules/new?from=${item.item_id}">Make a rule from this item</a></div>
  </form>
  <form method="post" action="/banking/item/${item.item_id}/transfer" class="card editor">${csrfField(csrf)}
    <h2>Transfer</h2>
    <p class="muted small">Money ${out ? 'moved from' : 'moved into'} ${item.books_name} ${out ? 'to' : 'from'} another of the company’s accounts (a card payment, savings, a loan).</p>
    <label class="field"><span>${out ? 'To account' : 'From account'}</span><select name="other" required><option value="">Choose…</option>
      ${transferTo.map(a => html`<option value="${a.account_id}">${a.name}</option>`)}</select></label>
    <div class="form-actions"><button class="primary">Record transfer</button></div>
  </form>
  <div class="card"><h2>Exclude</h2><p class="muted small">For duplicates and personal items: nothing goes into the books. You can undo it from the Excluded tab.</p>
    ${postButton({ action: `/banking/item/${item.item_id}/exclude`, csrf, label: 'Exclude', cls: '' })}</div>` : ''}` });
}

// "Who is this?" — AI vendor research on the bank item (stage B5): the proposal, its reasons and sources, Accept / Reject.
function researchCard({ csrf, item, research: r, ai }) {
  if (!ai) return '';
  const ask = label => postButton({ action: `/banking/item/${item.item_id}/research`, csrf, label, cls: '' });
  const p = r?.proposal;
  return html`<section class="card research"><h2>Who is this?</h2>
  ${!r ? (ai.on ? html`<p class="muted small">Looks the payee up on the web and suggests the vendor and category. Sends the bank description and your vendor and
      category names to ${ai.providerName}.</p>${ask('Research this payee')}`
    : html`<p class="muted small">AI vendor research is off.${ai.canSetUp ? html` Connect Claude or OpenRouter in <a href="/settings/ai">Settings → AI</a>.` : ''}</p>`)
  : r.status === 'failed' ? html`<p class="warn">The last try didn’t work: ${r.error}</p>${ai.on ? ask('Try again') : ''}`
  : html`<p><strong>${p.business_name}</strong>${p.what_they_do ? html` — ${p.what_they_do}` : ''} <span class="${p.confidence === 'high' ? 'tag ok' : 'tag'}">${p.confidence === 'high' ? 'Sure' : p.confidence === 'medium' ? 'Likely' : 'Maybe'}</span></p>
    <dl class="facts">
      <dt>Vendor</dt><dd>${r.vendor_name ? html`${r.vendor_name} <small class="muted">(already a vendor)</small>`
        : p.new_vendor ? html`New vendor: ${p.new_vendor.display_name}${[p.new_vendor.city, p.new_vendor.state].filter(Boolean).length ? ` · ${[p.new_vendor.city, p.new_vendor.state].filter(Boolean).join(', ')}` : ''}${p.new_vendor.website ? ` · ${p.new_vendor.website}` : ''}` : '—'}</dd>
      <dt>Category</dt><dd>${r.category_name ?? '—'}</dd>
    </dl>
    ${p.reasons ? html`<p class="muted small">${p.reasons}</p>` : ''}
    ${r.sources.length ? html`<p class="small">Sources: ${r.sources.map((x, i) => html`${i ? ' · ' : ''}<a href="${x.url}" target="_blank" rel="noopener noreferrer nofollow">${x.title}</a>`)}</p>` : ''}
    ${Number(r.item_id) !== Number(item.item_id) ? html`<p class="muted small">From research on another item with the same payee.</p>` : ''}
    ${r.decision ? html`<p class="muted small">${r.decision === 'accepted' ? 'Accepted' : 'Rejected'} by ${r.decided_by}.</p>${r.decision === 'rejected' && ai.on ? ask('Research again') : ''}`
      : html`<div class="form-actions">${postButton({ action: `/banking/research/${r.research_id}/accept`, csrf, label: p.new_vendor && !r.vendor_name ? 'Accept and add the vendor' : 'Accept', cls: 'primary' })}
        ${postButton({ action: `/banking/research/${r.research_id}/reject`, csrf, label: 'Reject', cls: '' })}${ai.on ? ask('Research again') : ''}</div>`}`}
  </section>`;
}
