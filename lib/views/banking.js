import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatDateTime } from './format.js';
import { linkOf } from './accounts.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { itemToken, evidenceToken } from '../data/banking.js';
import { orderFor } from '../bankfeed/pickers.js';
import { ruleStamp } from '../bankfeed/rules.js';

// Bank transactions (stage B3, QBO's Banking page): account cards across the top, For review / Categorized / Excluded tabs,
// and one page per bank item to match, add, transfer or exclude it.

const TABS = [['review', 'For review'], ['categorized', 'Categorized'], ['excluded', 'Excluded'], ['changed', 'Changed']];
const ATTENTION = { removed: 'Removed by the bank — check it', changed: 'Changed by the bank — check it', books: 'Changed in the books — check it' };
// Where a review came from, for the Categorized tab and the item's history.
const SOURCE = { manual: 'by hand', row: 'from the list', batch: 'in a batch', auto: 'automatically' };
export function provenance(e) {
  if (!e) return '';
  const why = e.basis === 'rule' && e.rule_name ? `rule “${e.rule_name}”` : e.basis === 'history' ? 'earlier items' : e.basis === 'match' ? 'a suggested match'
    : e.basis === 'ai' ? 'AI research' : null;
  return `${SOURCE[e.source] ?? e.source}${why ? ` from ${why}` : ''}${e.separate ? ' · marked separate' : ''}`;
}
const KIND = { bank: 'Bank', credit_card: 'Card', long_term_liability: 'Loan', other_current_liability: 'Liability' };
const spent = c => (Number(c) < 0 ? formatCents(-Number(c)) : '');
const received = c => (Number(c) > 0 ? formatCents(Number(c)) : '');
// The rule a form was filled in from, as it stood when shown — kept through a form shown again after an error.
// The history suggestion a row showed (its category, payee, class and location), kept through a row shown again after an error:
// posting it unchanged records it as history, with its class and location.
const historyFields = x => (x ? html`<input type="hidden" name="basis" value="history"><input type="hidden" name="hist_account" value="${x.account ?? ''}"><input type="hidden" name="hist_payee" value="${x.payee ?? ''}"><input type="hidden" name="hist_class" value="${x.classId ?? ''}"><input type="hidden" name="hist_location" value="${x.locationId ?? ''}">` : '');
const ruleFields = r => (r ? html`<input type="hidden" name="rule" value="${r.id}"><input type="hidden" name="rule_at" value="${r.at ?? ''}">` : '');
const txnLabel = t => `${TYPE_LABELS[t.type] ?? t.type}${t.doc_number ? ` ${t.doc_number}` : ''}`;

// The suggestion cell: a match, a rule, or what was done before.
const SURE = { high: 'Sure', medium: 'Likely', low: 'Maybe' };
// What the books already hold that could be this line, in a few words: "Same amount in the books: Expense · Quillback
// Mutual · 9/12/26". Post as new records it as a separate one; More opens it to match.
const maybeInBooks = s => `${s.count === 1 ? 'Same amount in the books' : `${s.count} in the books for this amount`}: ${s.dupes.slice(0, 2).map(d =>
  `${TYPE_LABELS[d.type] ?? d.type}${d.doc_number ? ` ${d.doc_number}` : ''}${d.party ? ` · ${d.party}` : ''} · ${formatShortDate(d.txn_date)}${DUPE_WHY[d.reason] ?? ''}`).join('; ')}${s.count > 2 ? ' …' : ''}. Post as new only if this is a separate one; More to match it.`;
// A texted receipt matched to this line (stage S3): it goes with the line when it's reviewed (its photo onto the transaction).
const receiptLine = r => html`<small class="muted receipt-line">Receipt${r.extracted?.vendor ? ` from ${r.extracted.vendor}` : ''}${r.extracted?.total_cents ? ` · ${formatCents(r.extracted.total_cents)}` : ''}, texted ${formatShortDate(new Date(r.created_at).toISOString().slice(0, 10))}${r.sender ? ` by ${r.sender}` : ''} · <a href="/receipts/${r.receipt_id}/image" target="_blank" rel="noopener">see it</a> — goes with this line</small>`;
// The party this line names has open bills or invoices (stage S4): a link to Find match on the item page, narrowed to them.
const openDocsLink = (i, o) => html`<small><a href="/banking/item/${i.item_id}?${new URLSearchParams({ find: '1', q: o.name })}#match">${o.n} open ${o.type === 'bill' ? 'bill' : 'invoice'}${o.n === 1 ? '' : 's'} from ${o.name} (${formatCents(o.total)})</a> — choose which in Find match</small>`;
// A pending row (stage S2): what it will be suggested as once it posts — shown only, nothing to choose yet. (Read-only
// people see it in the Suggestion column, with the payee.)
const pendingText = (p, accountNames, practice) => p
  ? html`<span class="muted small">Will suggest:</span> ${suggestionText(p.s, accountNames, { practice })}${p.payee ? html`<small class="muted">${p.payee}</small>` : ''}<small class="muted">Can be reviewed once the bank posts it</small>`
  : html`<span class="muted small">Pending at the bank</span>`;
// A pending row (stage S2): what it will be suggested as once it posts — shown only, nothing to choose yet.
const pendingCells = (p, accountNames, practice) => p
  ? html`<td><span class="muted">${p.payee ?? '—'}</span></td><td><span class="muted small">Will suggest:</span> ${suggestionText(p.s, accountNames, { practice })}<small class="muted">Can be reviewed once the bank posts it</small></td>`
  : html`<td><span class="muted">—</span></td><td><span class="muted small">Can be reviewed once the bank posts it</span></td>`;
export function suggestionText(s, accountNames, { practice = false } = {}) {
  if (!s) return html`<span class="muted">—</span>`;
  if (s.source === 'match') return html`<span class="tag ok">Match</span> ${txnLabel(s.txn)}${s.txn.party ? ` · ${s.txn.party}` : ''} · ${formatShortDate(s.txn.txn_date)}`;
  if (s.source === 'settle') return html`<span class="${s.confidence === 'high' ? 'tag ok' : 'tag'}">Match</span> ${s.doc.type === 'bill' ? 'Pay bill' : 'Payment for invoice'}${s.doc.doc_number ? ` ${s.doc.doc_number}` : ''} · ${s.doc.party ?? ''}<small class="muted">Open ${formatCents(s.doc.open_cents)} · ${formatShortDate(s.doc.txn_date)}${s.named ? '' : ' · the bank doesn’t name them: check it'}</small>`;
  if (s.source === 'open_docs') return html`<span class="muted">—</span>`;
  if (s.source === 'possible') return html`<span class="tag warn">Check</span> ${s.count === 1 ? 'May already be in the books' : `${s.count} things in the books could be this`}<small class="muted">Open it to match or decide</small>`;
  const what = accountNames.get(Number(s.accountId)) ?? '';
  if (s.source === 'ai') return html`<span class="tag">AI</span> ${s.research.business_name ?? ''}${what ? ` → ${what}` : ''}<small class="muted">Researched — open to accept</small>`;
  if (s.source === 'rule') return html`<span class="tag ok">Rule</span> ${s.split ? `Split: ${s.lines.map(l => `${accountNames.get(Number(l.accountId)) ?? ''} ${formatCents(l.cents)}`).join(' · ')}` : what}<small class="muted">${s.rule.name}${s.rule.mode === 'auto' ? (practice ? ' (suggests here; adds automatically in the live books)' : ' (adds automatically)') : ''}</small>`;
  return html`<span class="${s.confidence === 'high' ? 'tag ok' : 'tag'}">${SURE[s.confidence]}</span> ${what}<small class="muted">${s.basis === 'card' ? `Card payment — to this card by ${s.cardWhy}` : s.basis === 'wording' ? `Same bank wording as ${s.count === s.of ? s.count : `${s.count} of ${s.of}`} earlier (last ${formatShortDate(s.last)})` : s.basis === 'books' ? `Like ${s.count} of ${s.of} of ${s.vendorName}’s in the books` : `Like ${s.count} of ${s.of} earlier item${s.of === 1 ? '' : 's'}`}</small>`;
}

export function bankingPage({ entityName, csrf, flash, timeZone, accounts, current, tab, items, counts, suggestions, intents = new Map(), previews = new Map(), receipts = new Map(), accountNames = new Map(), canRefresh, canReview,
  page, more, practice = false, cats = [], payees = [], draft = null, focus = null, catsV = '', payeesV = '', list = { raw: {}, size: 50 }, total = 0, rules = [], undo = new Map(), filtered = false }) {
  // Links keep the filters, order and page size (stage BR-6); switching tabs keeps them too.
  const q = (o = {}) => `/banking?${new URLSearchParams({ account: current?.id ?? '', tab, ...list.raw, ...o })}`;
  // Ticking: For review (accept, exclude, assign) and Categorized / Excluded (undo); never Changed.
  const picks = canReview && tab !== 'changed';
  // For review rows are reviewed in place (stage BR-2): each has its own form (rendered after the table — forms can't sit
  // inside a table row or inside the batch form); the row's fields point at it with form="row-<id>".
  const inRow = tab === 'review' && canReview;
  const reviewable = items.filter(i => !i.pending);
  const nextOf = new Map(reviewable.map((i, n) => [Number(i.item_id), reviewable[n + 1]?.item_id ?? reviewable[n - 1]?.item_id ?? '']));
  const catNames = new Map(cats.map(c => [c.id, c.value]));
  const payeeNames = new Map(payees.map(p => [p.key, p.value]));
  // A choice carried over from an earlier page ({ id } / { key }) is shown with this page's label for that record.
  const shownCategory = x => (x && typeof x === 'object' ? catNames.get(Number(x.id)) ?? '' : x ?? '');
  const shownPayee = x => (x && typeof x === 'object' ? payeeNames.get(x.key) ?? '' : x ?? '');
  const rowFields = i => {
    const s = suggestions.get(Number(i.item_id));
    // A row shown again after an error keeps what was typed — unless its rule changed: then it is shown afresh, with the error.
    const mine = draft && draft.itemId === Number(i.item_id) ? draft : null;
    const d = mine && !mine.fresh ? mine : null;
    const out = Number(i.amount_cents) < 0;
    const isMatch = s?.source === 'match' && !d;
    // An open bill or invoice this line pays (stage S4): matched like a match, with its own form.
    const isSettle = s?.source === 'settle' && !d;
    // Something in the books may already be this line: the row shows that evidence and is filled in with what the line
    // would be as a new one (s.fill), posted only with "Post as new".
    const possible = s?.source === 'possible';
    // A weak AI guess ("Maybe": the research couldn't tell who it is) is shown as a hint, never filled in.
    const t0 = possible ? s.fill ?? null : s;
    const t = t0?.source === 'ai' && t0.confidence === 'low' ? null : t0;
    // A texted receipt matched to the line (stage S3) fills in a row nothing else suggested anything for — so what a rule,
    // history or batch Accept would post is never changed by it.
    // A receipt is the purchase itself: it also comes before an AI guess (stage S5) — its vendor and category first.
    const rc = (receipts.get(Number(i.item_id)) ?? []).length === 1 && (!t || t.source === 'open_docs' || t.source === 'ai') ? receipts.get(Number(i.item_id))[0] : null;
    const overAi = Boolean(rc && t?.source === 'ai' && !d);
    const payee0 = d ? shownPayee(d.payee) : t && !['match', 'possible', 'ai'].includes(t.source) ? payeeNames.get(t.payee) ?? '' : t?.source === 'ai' && t.payee ? payeeNames.get(t.payee) ?? '' : '';
    const category0 = d ? shownCategory(d.category) : t && !['match', 'possible'].includes(t.source) && !t.split ? catNames.get(Number(t.accountId)) ?? '' : '';
    return { s, t, d, out, isMatch, isSettle, possible, freshError: mine?.fresh ? mine.error : null,
      payee: (overAi && rc.vendor_id ? payeeNames.get(`v:${rc.vendor_id}`) : null) || payee0 || (!d && rc?.vendor_id ? payeeNames.get(`v:${rc.vendor_id}`) ?? '' : ''),
      // A rule's split is posted from the item page or by Accept; the row takes one category.
      category: (overAi && rc.account_id ? catNames.get(Number(rc.account_id)) : null) || category0 || (!d && rc?.account_id ? catNames.get(Number(rc.account_id)) ?? '' : ''),
      memo: d ? d.memo ?? '' : t?.source === 'rule' ? t.memo ?? '' : '' };
  };
  return layout({ title: 'Bank transactions', entityName, csrf, flash, body: html`<div class="page-actions"><h1>Bank transactions</h1><span class="spacer"></span>
    ${canReview && accounts.length ? html`<a class="button" href="/banking/rules">Rules</a>` : ''}
    ${canRefresh && accounts.length ? postButton({ action: '/bank-feeds/refresh', csrf, label: 'Refresh', cls: '', extra: { back: q() } }) : ''}</div>
  ${!accounts.length ? html`<div class="card"><p>No bank or card accounts are connected yet.</p>
    <p class="muted">An admin links this company to ledgerline and matches its accounts in <a href="/settings/bank-feeds">Settings → Bank connections</a>.</p></div>` : html`
  <div class="bank-cards" role="list">${accounts.map(a => html`<a role="listitem" class="${a.id === current.id ? 'bank-card active' : 'bank-card'}" href="/banking?account=${a.id}"${a.id === current.id ? html` aria-current="page"` : ''}>
    <span class="bank-card-name">${a.books_name}</span><small class="muted">${KIND[a.books_type] ?? ''}${a.mask ? ` ••${a.mask}` : ''}</small>
    <span class="bank-card-row"><small>Bank</small><strong>${a.bank_balance_cents === null ? '—' : formatCents(Number(a.bank_balance_cents))}</strong></span>
    <span class="bank-card-row"><small>In books</small><strong>${formatCents(a.books_balance_cents)}</strong></span>
    <span class="bank-card-foot">${a.to_review ? html`<span class="tag">${a.to_review} to review</span>` : html`<span class="tag ok" title="Every bank line brought in so far has been reviewed">Nothing waiting</span>`}
      ${a.pending ? html`<span class="tag" title="Still pending at the bank; they can be reviewed once they post">${a.pending} pending at bank</span>` : ''}
      ${a.verified_through ? html`<span class="tag ok" title="Ledgerline has checked this account against statements">Verified to ${formatShortDate(a.verified_through)}</span>` : ''}
      ${a.attention ? html`<span class="tag warn">${a.attention} changed at bank</span>` : ''}
      ${a.verified?.difference ? html`<span class="tag warn" title="Ledgerline proved this month against the bank statement">Books off by ${formatCents(a.verified.difference)} at ${formatShortDate(a.verified.periodEnd)}</span>` : ''}
      ${a.connection_state && a.connection_state !== 'healthy' ? html`<span class="tag warn">Connection: ${a.connection_state}</span>` : ''}</span>
  </a>`)}</div>
  ${current.balance_as_of ? html`<p class="muted small">Bank balance as of ${formatDateTime(current.balance_as_of, timeZone)}${current.balance_stale ? ' (older than a day and a half)' : ''}.</p>` : ''}
  <nav class="tabs" aria-label="Bank item tabs">${TABS.filter(([k]) => k !== 'changed' || counts.changed || tab === 'changed').map(([k, label]) => html`<a class="${k === tab ? 'tab active' : 'tab'}" href="${q({ tab: k })}"${k === tab ? html` aria-current="page"` : ''}>${label} (${counts[k] ?? 0})</a>`)}</nav>
  <p class="muted small" data-bank-live role="status" aria-live="polite"></p>
  ${filterBar({ current, tab, list, cats, rules, filtered, total, q })}
  <form method="post" action="/banking/batch" id="bank-batch" class="bank-batch">${csrfField(csrf)}<input type="hidden" name="account" value="${current.id}"><input type="hidden" name="tab" value="${tab}">
    <input type="hidden" name="list" value="${new URLSearchParams(list.raw).toString()}"><input type="hidden" name="cats_v" value="${catsV}"><input type="hidden" name="payees_v" value="${payeesV}">
    ${inRow && items.length ? html`<div class="page-actions"><span class="muted small">Review a row and Post it, or tick rows to accept their suggestions together: each does exactly what it shows. Anything that changed since this page was shown is left for review.${practice ? ' Practice copy: nothing is added on its own.' : ''}</span><span class="spacer"></span>
      <button name="action" value="accept" class="primary">Accept ticked</button><button name="action" value="exclude">Exclude ticked</button></div>
      <div class="batch-assign"><input name="assign_category" list="bank-cats-out" aria-label="Category to assign" placeholder="Category to assign" autocomplete="off">
        <input name="assign_payee" list="bank-payees" aria-label="Payee to assign" placeholder="Payee (optional)" autocomplete="off">
        <button name="action" value="assign">Assign to ticked</button>
        ${filtered && total ? html`<button name="all" value="assign:${total}" data-confirm="Assign this category to all ${total} matching? Each is added as it is now; anything the books may already hold is left for review.">Assign to all ${total} matching</button>` : ''}</div>
      ${filtered && total ? html`<p class="small">${postAll({ action: 'exclude', total, label: `Exclude all ${total} matching` })}</p>` : ''}` : ''}
    ${picks && tab !== 'review' && items.length ? html`<div class="page-actions"><span class="muted small">Tick items to undo them together: each is undone exactly as its row shows (what it added is deleted; a match is removed).</span><span class="spacer"></span>
      <button name="action" value="undo">${tab === 'excluded' ? 'Restore ticked' : 'Undo ticked'}</button>
      ${filtered && total ? postAll({ action: 'undo', total, label: `${tab === 'excluded' ? 'Restore' : 'Undo'} all ${total} matching` }) : ''}</div>` : ''}</form>
    ${items.length ? html`<div class="table-scroll"><table class="grid bank-items${inRow ? ' in-row' : ''}">
      <thead><tr>${picks ? html`<th class="pick"><input type="checkbox" data-select-all aria-label="Tick every row on this page" hidden></th>` : ''}<th>Date</th><th>Bank description</th>${inRow ? html`<th>Payee</th><th>Category or match</th>` : html`<th>${tab === 'review' ? 'Suggestion' : 'Recorded as'}</th>${tab === 'categorized' ? html`<th>Category</th>` : ''}`}
        <th class="num">Spent</th><th class="num">Received</th><th class="actions"></th></tr></thead>
      <tbody>${items.map(i => {
        const s = suggestions.get(Number(i.item_id));
        const r = inRow && !i.pending ? rowFields(i) : null;
        const f = `row-${i.item_id}`;
        return html`<tr id="item-${i.item_id}" data-row="${i.item_id}" class="${i.pending ? 'pending' : ''}${r?.d || r?.freshError ? ' row-error' : ''}">
        ${inRow ? html`<td class="pick" data-label="">${i.pending ? '' : html`<input type="checkbox" name="item" value="${i.item_id}" form="bank-batch" aria-label="Tick ${i.description}"><input type="hidden" name="rev_${i.item_id}" value="${itemToken(i)}" form="bank-batch">${intents.get(Number(i.item_id)) ? html`<input type="hidden" name="intent_${i.item_id}" value="${intents.get(Number(i.item_id))}" form="bank-batch">` : ''}`}</td>`
          : picks ? html`<td class="pick" data-label="">${undo.get(Number(i.item_id)) ? html`<input type="checkbox" name="item" value="${i.item_id}" form="bank-batch" aria-label="Tick ${i.description}"><input type="hidden" name="plan_${i.item_id}" value="${undo.get(Number(i.item_id)).token}" form="bank-batch">` : ''}</td>` : ''}
        <td>${formatShortDate(i.posted_date)}</td>
        <td><a href="/banking/item/${i.item_id}">${i.description || '(no description)'}</a>${i.merchant_name ? html`<small class="muted">${i.merchant_name}</small>` : ''}
          ${(receipts.get(Number(i.item_id)) ?? []).map(r => receiptLine(r))}${i.pending ? html`<small class="muted">Pending at the bank</small>` : ''}${i.files ? html`<small class="muted">${i.files} file${i.files === 1 ? '' : 's'}</small>` : ''}${i.note ? html`<small class="muted note">Note: ${i.note}</small>` : ''}${i.attention ? html`<small class="warn">${ATTENTION[i.attention] ?? 'Check it'}</small>` : ''}</td>
        ${r ? html`<td>${r.isMatch || r.isSettle ? html`<span class="muted small">${(r.isSettle ? s.doc.party : s.txn.party) ?? ''}</span>` : html`<input name="payee" form="${f}" list="bank-payees" value="${r.payee}" aria-label="Payee for ${i.description}" placeholder="Payee" autocomplete="off"><input name="memo" form="${f}" class="row-memo" value="${r.memo}" aria-label="Memo for ${i.description}" placeholder="Memo" autocomplete="off">`}</td>
          <td>${r.isMatch || r.isSettle ? suggestionText(s, accountNames, { practice })
            : html`<input name="category" form="${f}" list="${r.out ? 'bank-cats-out' : 'bank-cats-in'}" value="${r.category}" aria-label="Category for ${i.description}" placeholder="Choose a category" autocomplete="off"${Number(focus) === Number(i.item_id) ? html` autofocus` : ''}>
              ${r.possible ? html`<small class="warn">${maybeInBooks(s)}</small>${r.t ? html`<small class="muted">${suggestionText(r.t, accountNames, { practice })}</small>` : ''}`
                : s && s.source !== 'match' ? html`<small class="muted">${suggestionText(s, accountNames, { practice })}</small>` : ''}`}
            ${r.freshError ? html`<small class="warn" role="alert">${r.freshError}</small>` : ''}${r.d?.error ? html`<small class="warn" role="alert">${r.d.error}</small>${r.d.create ? html` <button name="create" value="vendor" form="${f}" class="link">Create vendor “${r.d.create}”</button> · <button name="create" value="customer" form="${f}" class="link">Create customer “${r.d.create}”</button>` : ''}` : ''}
            ${s?.openDocs && !r.isSettle ? openDocsLink(i, s.openDocs) : ''}<small class="warn row-msg" role="status" aria-live="polite"></small></td>`
        // A pending row keeps the row's columns: nothing to choose yet.
        : inRow ? pendingCells(previews.get(Number(i.item_id)), accountNames, practice)
        : html`<td>${tab === 'review' ? (i.pending ? pendingText(previews.get(Number(i.item_id)), accountNames, practice) : suggestionText(s, accountNames, { practice }))
          : i.review_state === 'excluded' ? html`<span class="muted">Excluded</span>`
          : i.review_state === 'new' ? html`<span class="muted">For review</span>`
          : html`${i.links.map((l, n) => html`${n ? ', ' : ''}${l.how === 'matched' ? 'Matched to ' : 'Added: '}<a href="${linkOf(l)}">${txnLabel(l)}</a>${l.party ? ` · ${l.party}` : ''}`)}${i.made_event ? html`<small class="muted">${provenance(i.made_event)}</small>` : i.rule_name ? html`<small class="muted">Added by rule ${i.rule_name}</small>` : ''}${i.last_event?.kind === 'checked' ? html`<small class="muted">Checked by ${i.last_event.actor}</small>` : ''}`}</td>${tab === 'categorized' ? html`<td>${i.categories ?? ''}</td>` : ''}`}
        <td class="num">${spent(i.amount_cents)}</td><td class="num">${received(i.amount_cents)}</td>
        <td class="actions">${r ? html`<button form="${f}" class="${!r.possible && (r.isMatch || (r.isSettle && s.confidence === 'high') || r.category) ? 'primary' : ''}">${r.isMatch || r.isSettle ? 'Match' : r.possible ? 'Post as new' : 'Post'}</button> ` : ''}${i.pending ? '' : html`<a href="/banking/item/${i.item_id}">${tab === 'review' ? 'More' : 'View'}</a>`}
          ${undo.get(Number(i.item_id)) ? postButton({ action: `/banking/item/${i.item_id}/undo`, csrf, label: i.review_state === 'excluded' ? 'Restore' : 'Undo', cls: 'link', confirm: undo.get(Number(i.item_id)).confirm, extra: { plan: undo.get(Number(i.item_id)).token, back: q({ page }) } }) : ''}</td>
      </tr>`;
      })}</tbody></table></div>
      ${inRow ? reviewable.map(i => {
        const r = rowFields(i);
        const s = r.isMatch || r.isSettle ? r.s : r.t;
        return html`<form id="row-${i.item_id}" method="post" action="/banking/item/${i.item_id}/row" data-row-form>${csrfField(csrf)}
          <input type="hidden" name="rev" value="${itemToken(i)}"><input type="hidden" name="next" value="${nextOf.get(Number(i.item_id))}">
          <input type="hidden" name="cats_v" value="${catsV}"><input type="hidden" name="payees_v" value="${payeesV}">
          ${r.isSettle ? html`<input type="hidden" name="mode" value="settle"><input type="hidden" name="txn" value="${s.doc.txn_id}"><input type="hidden" name="ver" value="${s.doc.version ?? ''}"><input type="hidden" name="evidence" value="${evidenceToken(s.dupes)}">`
            : r.isMatch ? html`<input type="hidden" name="mode" value="match"><input type="hidden" name="txn" value="${s.txn.txn_id}"><input type="hidden" name="ver" value="${s.txn.version ?? ''}">`
            : html`<input type="hidden" name="mode" value="add">${r.possible ? html`<input type="hidden" name="separate" value="1"><input type="hidden" name="evidence" value="${evidenceToken(r.s.dupes)}">` : ''}${ruleFields(r.d && !r.d.fresh ? (r.d.rule ? { id: r.d.rule, at: r.d.ruleAt } : null) : s?.source === 'rule' ? { id: s.rule.rule_id, at: ruleStamp(s.rule) } : null)}${historyFields(r.d && !r.d.fresh ? r.d.hist : s?.source === 'history' ? { account: s.accountId, payee: s.payee ?? '', classId: s.classId ?? '', locationId: s.locationId ?? '' } : null)}`}
        </form>`;
      }) : ''}
      ${inRow || picks ? html`<datalist id="bank-payees">${payees.map(p => html`<option value="${p.value}" label="${p.kind}"></option>`)}</datalist>
        <datalist id="bank-cats-out">${orderFor(cats, true).map(c => html`<option value="${c.value}" label="${c.label}"></option>`)}</datalist>
        <datalist id="bank-cats-in">${orderFor(cats, false).map(c => html`<option value="${c.value}" label="${c.label}"></option>`)}</datalist>` : ''}
      ${page > 1 || more ? html`<p class="pager">${page > 1 ? html`<a href="${q({ page: page - 1 })}">‹ Newer</a>` : ''} ${more ? html`<a href="${q({ page: page + 1 })}">Older ›</a>` : ''}</p>` : ''}`
    : html`<p class="muted">${tab === 'review' ? 'Nothing to review on this account.' : tab === 'categorized' ? 'Nothing categorized yet.' : tab === 'changed' ? 'Nothing changed since it was reviewed.' : 'Nothing excluded.'}</p>`}
  `}` });
}

// The list's filter (stage BR-6): a GET form, so a filtered list is a link that can be kept or shared.
const FILTER_HOW = { person: 'By a person', batch: 'In a batch', auto: 'By an automatic rule' };
const SORT_NAMES = { new: 'Newest first', old: 'Oldest first', big: 'Largest first', small: 'Smallest first' };
function filterBar({ current, tab, list, cats, rules, filtered, total, q }) {
  const v = list.raw;
  const opt = (value, label, cur) => html`<option value="${value}"${String(cur ?? '') === String(value) ? html` selected` : ''}>${label}</option>`;
  return html`<details class="bank-filter"${filtered ? html` open` : ''}><summary>Filter${filtered ? html` · <strong>${total} matching</strong>` : ''}</summary>
    <form method="get" action="/banking" class="find-form"><input type="hidden" name="account" value="${current.id}"><input type="hidden" name="tab" value="${tab}">
      <div class="form-grid">
        <label class="field"><span>Search</span><input name="q" value="${v.q ?? ''}" placeholder="Description or payee"></label>
        <label class="field"><span>From</span><input type="date" name="from" value="${v.from ?? ''}"></label>
        <label class="field"><span>To</span><input type="date" name="to" value="${v.to ?? ''}"></label>
        <label class="field"><span>Amount from</span><input name="min" inputmode="decimal" value="${v.min ?? ''}"></label>
        <label class="field"><span>Amount to</span><input name="max" inputmode="decimal" value="${v.max ?? ''}"></label>
        <label class="field"><span>Money</span><select name="dir">${opt('', 'In and out', v.dir)}${opt('out', 'Spent', v.dir)}${opt('in', 'Received', v.dir)}</select></label>
        ${tab !== 'review' ? html`<label class="field"><span>Category</span><select name="category">${opt('', 'Any', v.category)}${cats.map(c => opt(c.id, c.value, v.category))}</select></label>
          <label class="field"><span>Rule</span><select name="rule">${opt('', 'Any', v.rule)}${rules.map(r => opt(r.rule_id, r.name, v.rule))}</select></label>
          <label class="field"><span>Decided</span><select name="how">${opt('', 'Any way', v.how)}${Object.entries(FILTER_HOW).map(([k, l]) => opt(k, l, v.how))}</select></label>` : ''}
        <label class="field"><span>Order</span><select name="sort">${Object.entries(SORT_NAMES).map(([k, l]) => opt(k, l, v.sort ?? 'new'))}</select></label>
        <label class="field"><span>Per page</span><select name="size">${[50, 100, 200, 300].map(n => opt(n, String(n), list.size))}</select></label>
      </div>
      <div class="form-actions"><button>Filter</button><a href="/banking?${new URLSearchParams({ account: current.id, tab })}">Clear</a>
        <a href="${q({ page: '' }).replace('/banking?', '/banking/export.csv?')}">Export CSV</a></div>
    </form></details>`;
}
// "All N matching": the count shown is sent back; the server refuses if the list doesn't have exactly that many now.
const postAll = ({ action, total, label }) => html`<button name="all" value="${action}:${total}" data-confirm="${label}? Each is done as it is now; anything the books may already hold is left for review.">${label}</button>`;

const DUPE_WHY = { replaced: ' — on a bank line the bank later removed', open_bill: ' — open bill', open_invoice: ' — open invoice', waiting: ' — waiting to be deposited' };
const ATTENTION_LONG = {
  removed: 'The bank removed this item after it was reviewed. Check the books transaction, then undo if it shouldn’t be there.',
  changed: 'The bank changed this item’s amount or date after it was reviewed. Check the books transaction.',
  books: 'A books transaction behind this item was edited or deleted, so the books no longer show the bank amount for it. Check it, then undo and review again if needed.',
};
const EVENT_KIND = { added: 'Added', matched: 'Matched', transfer: 'Transfer recorded', settled: 'Settled', excluded: 'Excluded', undone: 'Undone', restored: 'Restored',
  checked: 'Checked', books_changed: 'Its books transaction was edited', books_deleted: 'Its books transaction was deleted' };

// After a batch: what happened to every ticked item.
// "All N matching", step one: exactly what Confirm will do, item by item.
export function batchConfirmPage({ entityName, csrf, flash, action, back, items, selection, assignTo = null }) {
  const verb = { exclude: 'Exclude', assign: `Assign ${assignTo ?? ''} to`, undo: 'Undo' }[action];
  return layout({ title: 'Confirm', entityName, csrf, flash, body: html`<div class="crumbs"><a href="${back}">‹ Bank transactions</a></div>
  <h1>${verb} these ${items.length} item${items.length === 1 ? '' : 's'}?</h1>
  <p class="muted">Only these, each as shown here: anything that changes before you confirm is left for review, with the reason.</p>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Date</th><th>Bank item</th><th class="num">Amount</th>${action === 'undo' ? html`<th>Undo will</th>` : ''}</tr></thead>
    <tbody>${items.map(x => html`<tr><td>${formatShortDate(x.item.posted_date)}</td><td><a href="/banking/item/${x.item.item_id}">${x.item.description}</a></td>
      <td class="num">${formatCents(Number(x.item.amount_cents))}</td>${action === 'undo' ? html`<td class="small">${x.confirm ?? 'Put it back for review'}</td>` : ''}</tr>`)}</tbody></table></div>
  <form method="post" action="/banking/batch/confirm" class="form-actions">${csrfField(csrf)}<input type="hidden" name="selection" value="${selection}">
    <button class="primary">${verb.replace(/ to$/, '')} ${items.length}</button><a href="${back}">Cancel</a></form>` });
}

const BATCH_TITLE = { exclude: 'Exclude', accept: 'Accept', assign: 'Assign', undo: 'Undo' };
const OUTCOME = { excluded: 'Excluded', accepted: 'Accepted', assigned: 'Added', undone: 'Undone' };
export function batchResultsPage({ entityName, csrf, flash, action, back, results }) {
  const done = results.filter(r => r.outcome !== 'skipped');
  return layout({ title: 'Batch results', entityName, csrf, flash, body: html`<div class="crumbs"><a href="${back}">‹ Bank transactions</a></div>
  <h1>${BATCH_TITLE[action] ?? 'Accept'}: ${done.length} of ${results.length} done</h1>
  <div class="table-scroll"><table class="grid"><thead><tr><th>Bank item</th><th>Result</th></tr></thead>
    <tbody>${results.map(r => html`<tr><td><a href="/banking/item/${r.itemId}">${r.description}</a></td>
      <td>${r.outcome === 'skipped' ? html`<span class="tag warn">Left for review</span> ${r.reason ?? ''}` : html`<span class="tag ok">${OUTCOME[r.outcome] ?? 'Accepted'}</span>`}</td></tr>`)}</tbody></table></div>
  <p><a class="button primary" href="${back}">Back to the list</a></p>` });
}

// One bank item: what the bank says, and (if it's waiting) the four things you can do with it.
export function bankItemPage({ entityName, csrf, flash, item, candidates, suggested, suggestion = null, vendors, customers, categories, transferTo, links, error = null, v: typed = null, canReview,
  research = null, ai = null, prefill = null, rev = '', preview = null, receipts = [], dupes = [], evidence = '', dims = null, events = [], undoConfirm = null, undoToken = null, practice = false,
  cats = [], payeeList = [], catsV = '', payeesV = '', createPayee = null, find = null, found = null, settleDocs = [], mv = null, hist = null, files = [], notes = [], canApprove = false }) {
  // The Add form starts from the rule or history suggestion — or, when there is none (or only an AI guess or the open-documents
  // pointer), from the one texted receipt that fits the line: the purchase itself (stage S5).
  const fromReceipt = receipts.length === 1 && (receipts[0].vendor_id || receipts[0].account_id) && (!suggestion || ['ai', 'open_docs'].includes(suggestion.source))
    ? receipts[0] : null;
  const fromSuggestion = !fromReceipt && suggestion && !['match', 'possible', 'open_docs'].includes(suggestion.source) && !(suggestion.source === 'ai' && suggestion.confidence === 'low');
  const v = typed ?? prefill ?? (fromReceipt ? { payee: fromReceipt.vendor_id ? `v:${fromReceipt.vendor_id}`
    : suggestion && !(suggestion.source === 'ai' && suggestion.confidence === 'low') ? suggestion.payee ?? '' : '', memo: '',
    lines: [{ accountId: fromReceipt.account_id ?? '' }] } : fromSuggestion ? { payee: suggestion.payee ?? '', memo: suggestion.memo ?? '', classId: suggestion.classId ?? '', locationId: suggestion.locationId ?? '',
    lines: suggestion.lines?.length > 1 ? suggestion.lines.map(l => ({ accountId: l.accountId, amount: l.amount, description: l.description, classId: suggestion.classId ?? '' })) : [{ accountId: suggestion.accountId ?? '' }] } : {});
  const revField = html`<input type="hidden" name="rev" value="${rev}">`;
  // Something in the books may already be this item: say so above Add and Transfer, with the one way past it.
  const separateBox = dupes.length ? html`<div class="warn-box"><p><strong>This may already be in the books:</strong></p><ul class="small">${dupes.slice(0, 8).map(d => html`<li>${txnLabel(d)}${d.party ? ` · ${d.party}` : ''} · ${formatShortDate(d.txn_date)} · ${formatCents(Math.abs(Number(d.amount_cents)))}${DUPE_WHY[d.reason] ?? ''}</li>`)}</ul>
    <p class="small">Match it above if it’s one of these. If this really is a different, new transaction:</p>
    <input type="hidden" name="evidence" value="${evidence}">
    <label class="check"><input type="checkbox" name="separate" value="1"${typed?.separate ? html` checked` : ''}> This is a separate transaction</label></div>` : '';
  const dimsOn = dims && ((dims.settings.classesOn && dims.settings.classMode === 'txn') || dims.settings.locationsOn);
  const lineClassOn = dims && dims.settings.classesOn && dims.settings.classMode === 'line';
  const out = Number(item.amount_cents) < 0;
  const back = `/banking?account=${item.ll_account}&tab=${item.review_state === 'new' ? 'review' : item.review_state === 'excluded' ? 'excluded' : 'categorized'}`;
  const waiting = item.review_state === 'new' && item.bank_state === 'active' && !item.pending;
  const payees = out && item.books_type !== 'credit_card' && item.books_type !== 'bank' ? [...vendors, ...customers]
    : out ? vendors : item.books_type === 'bank' ? customers : [...vendors, ...customers];
  // Searchable pickers (stage BR-2): type to find the account or payee; the shared lists are at the end of the form.
  // What a person typed is shown as typed; a suggestion or a prefill (ids and keys) is shown as the list's value.
  // A choice carried over after an error ({ id } / { key }) is shown with this page's label for that record.
  const catValue = x => (x && typeof x === 'object' ? cats.find(c => c.id === Number(x.id))?.value ?? ''
    : typed ? String(x ?? '') : cats.find(c => c.id === Number(x))?.value ?? '');
  const payeeValue = x => (x && typeof x === 'object' ? payeeList.find(p => p.key === x.key)?.value ?? ''
    : typed ? String(x ?? '') : payeeList.find(p => p.key === x)?.value ?? '');
  const line = n => html`<div class="split-line">
    <label class="field"><span>${n ? `Category ${n + 1}` : 'Category'}</span><input name="line_account" list="item-cats" autocomplete="off" value="${catValue(v.lines?.[n]?.accountId)}"${n ? '' : html` required`} placeholder="${n ? '' : 'Type to find an account'}"></label>
    <label class="field"><span>Amount</span><input name="line_amount" inputmode="decimal" value="${v.lines?.[n]?.amount ?? ''}" placeholder="${n ? '' : (Math.abs(item.amount_cents) / 100).toFixed(2)}"></label>
    <label class="field"><span>Description</span><input name="line_description" value="${v.lines?.[n]?.description ?? ''}"></label>
    ${lineClassOn ? html`<label class="field"><span>Class</span><select name="line_class"><option value="">—</option>${dims.classes.map(c => html`<option value="${c.class_id}"${String(v.lines?.[n]?.classId ?? (n === 0 ? v.classId ?? '' : '')) === String(c.class_id) ? html` selected` : ''}>${c.full_name}</option>`)}</select></label>` : ''}</div>`;
  return layout({ title: 'Bank item', entityName, csrf, flash, body: html`<div class="crumbs"><a href="${back}">‹ Bank transactions</a></div>
  <h1>${item.description || 'Bank item'}</h1>${errorBanner(error)}
  <div class="card bank-item-facts"><dl class="facts">
    <dt>Account</dt><dd>${item.books_name}</dd>
    <dt>Date</dt><dd>${formatShortDate(item.posted_date)}${item.authorized_date && item.authorized_date !== item.posted_date ? html` <small class="muted">(authorized ${formatShortDate(item.authorized_date)})</small>` : ''}</dd>
    <dt>${out ? 'Spent' : 'Received'}</dt><dd><strong>${formatCents(Math.abs(Number(item.amount_cents)))}</strong></dd>
    ${item.merchant_name ? html`<dt>Merchant</dt><dd>${item.merchant_name}</dd>` : ''}
    ${item.check_number ? html`<dt>Check</dt><dd>${item.check_number}</dd>` : ''}
    ${item.category ? html`<dt>Bank’s category</dt><dd>${item.category.replaceAll('_', ' ').toLowerCase()}</dd>` : ''}
    ${receipts.length ? html`<dt>Receipt${receipts.length === 1 ? '' : 's'}</dt><dd>${receipts.map(r => receiptLine(r))}</dd>` : ''}
    <dt>Status</dt><dd>${item.pending ? html`Pending at the bank — it can be added once it posts.${preview ? html`<br><span class="muted">Will suggest:</span> ${suggestionText(preview.s, preview.names, { practice })}${preview.payee ? ` · ${preview.payee}` : ''}` : ''}` : item.bank_state === 'removed' ? 'Removed by the bank.'
      : item.review_state === 'new' ? 'For review' : item.review_state === 'excluded' ? 'Excluded' : `${item.review_state === 'matched' ? 'Matched' : 'Added'} by ${item.reviewed_by ?? '—'}`}</dd>
  </dl>
  ${links.length ? html`<p>${links.map((l, n) => html`${n ? html`<br>` : ''}${l.how === 'matched' ? 'Matched to' : l.how === 'grouped' ? 'Deposit made from waiting payments:' : 'Added as'} <a href="${linkOf(l)}">${txnLabel(l)}</a>${l.party ? ` · ${l.party}` : ''} · ${formatShortDate(l.txn_date)}`)}</p>` : ''}
  ${item.attention ? html`<p class="warn">${ATTENTION_LONG[item.attention] ?? ''}</p>
    ${canReview ? postButton({ action: `/banking/item/${item.item_id}/checked`, csrf, label: 'Checked — nothing to change', cls: '', extra: { rev } }) : ''}` : ''}
  ${canReview && item.review_state !== 'new' ? postButton({ action: `/banking/item/${item.item_id}/undo`, csrf, label: 'Undo', cls: '', confirm: undoConfirm, extra: { plan: undoToken ?? '' } }) : ''}
  ${item.auto_hold && item.review_state === 'new' ? html`<p class="muted small">Undone by a person — rules only suggest for this item until it’s reviewed again.</p>` : ''}
  ${filesAndNotes({ csrf, item, files, notes, canReview })}
  ${events.length ? html`<details class="small"><summary>History</summary><ul>${events.map(e => html`<li>${EVENT_KIND[e.kind] ?? e.kind} ${e.source === 'books' ? '' : provenance(e)} · ${e.actor} · ${formatShortDate(new Date(e.at).toISOString().slice(0, 10))}${Number(e.item_id) !== Number(item.item_id) ? html` <small class="muted">(an earlier copy of this bank line)</small>` : ''}</li>`)}</ul></details>` : ''}
  </div>
  ${waiting && canReview ? html`
  ${matchCard({ csrf, item, revField: html`${revField}<input type="hidden" name="cats_v" value="${catsV}">`, candidates, suggested, find, found, settleDocs, mv, out, cats })}
  ${historyCard({ item, hist, cats })}
  ${researchCard({ csrf, item, research, ai })}
  <form method="post" action="/banking/item/${item.item_id}/add" id="add" class="card editor" data-split data-target="${Math.abs(Number(item.amount_cents))}">${csrfField(csrf)}${revField}
    ${ruleFields(typed ? (typed.rule ? { id: typed.rule, at: typed.ruleAt } : null) : fromSuggestion && suggestion.source === 'rule' ? { id: suggestion.rule.rule_id, at: ruleStamp(suggestion.rule) } : null)}
    ${fromSuggestion && !typed && ['history', 'ai'].includes(suggestion.source) ? html`<input type="hidden" name="basis" value="${suggestion.source}">` : ''}
    <input type="hidden" name="cats_v" value="${catsV}"><input type="hidden" name="payees_v" value="${payeesV}">
    <h2>Add</h2>${separateBox}
    ${!typed && suggestion?.source === 'rule' ? html`<p class="tag ok">Filled in by rule “${suggestion.rule.name}”</p>`
      : !typed && prefill ? html`<p class="tag">${prefill.from === 'history' ? 'Filled in from the history — check it, then Add' : 'Filled in from the research — check it, then Add'}</p>`
      : !typed && suggestion?.source === 'ai' ? html`<p class="tag">Filled in from AI research on this payee — check it</p>`
      : !typed && suggestion?.source === 'history' ? html`<p class="${suggestion.confidence === 'high' ? 'tag ok' : 'tag'}">${suggestion.basis === 'books' ? `Filled in like ${suggestion.count} of ${suggestion.of} of ${suggestion.vendorName}’s transactions in the books`
        : `Filled in like ${suggestion.count} of ${suggestion.of} earlier item${suggestion.of === 1 ? '' : 's'} with this description`}</p>` : ''}
    <p class="muted small">Records ${out ? (item.books_type === 'bank' ? (item.check_number ? `check ${item.check_number}` : 'an expense') : item.books_type === 'credit_card' ? 'a card expense' : 'a journal entry')
      : item.books_type === 'bank' ? 'a deposit' : item.books_type === 'credit_card' ? 'a credit card credit (a journal entry when the payee is a customer)' : 'a journal entry'} on ${item.books_name} dated ${formatShortDate(item.posted_date)}. Split it across categories by filling more lines; a negative line takes some off (a discount, a fee kept back).</p>
    <label class="field"><span>Payee</span><input name="payee" list="item-payees" autocomplete="off" value="${payeeValue(v.payee)}" placeholder="Type to find a vendor or customer"></label>
    ${createPayee ? html`<p class="warn small">“${createPayee}” isn’t a vendor or customer yet: <button name="create" value="vendor" class="link">create vendor</button> · <button name="create" value="customer" class="link">create customer</button></p>` : ''}
    <datalist id="item-payees">${payeeList.map(p => html`<option value="${p.value}" label="${p.kind}"></option>`)}</datalist>
    <datalist id="item-cats">${orderFor(cats, out).filter(c => c.id !== Number(item.books_account_id)).map(c => html`<option value="${c.value}" label="${c.label}"></option>`)}</datalist>
    <div data-split-lines>${Array.from({ length: Math.max(3, v.lines?.length ?? 0) }, (_, n) => line(n))}</div>
    <p class="settle-total small" data-split-total aria-live="polite"></p>
    ${dimsOn ? html`<div class="form-grid dims">${dims.settings.classesOn && dims.settings.classMode === 'txn' ? html`<label class="field"><span>Class</span><select name="class_id"><option value="">—</option>${dims.classes.map(c => html`<option value="${c.class_id}"${String(v.classId ?? '') === String(c.class_id) ? html` selected` : ''}>${c.full_name}</option>`)}</select></label>` : ''}
      ${dims.settings.locationsOn ? html`<label class="field"><span>${dims.settings.locationLabel}</span><select name="location_id"><option value="">—</option>${dims.locations.map(l => html`<option value="${l.location_id}"${String(v.locationId ?? '') === String(l.location_id) ? html` selected` : ''}>${l.name}</option>`)}</select></label>` : ''}</div>` : ''}
    <label class="field"><span>Memo</span><input name="memo" value="${v.memo ?? ''}" placeholder="${item.description}"></label>
    <div class="form-actions"><button class="primary">Add</button><a href="/banking/rules/new?from=${item.item_id}">Make a rule from this item</a></div>
  </form>
  ${out && ['bank', 'credit_card'].includes(item.books_type) ? billCard({ csrf, item, revField: html`${revField}<input type="hidden" name="cats_v" value="${catsV}"><input type="hidden" name="payees_v" value="${payeesV}">`, typed, payeeList, dupes, evidence, canApprove, cats }) : ''}
  <form method="post" action="/banking/item/${item.item_id}/transfer" class="card editor">${csrfField(csrf)}${revField}
    <h2>Transfer</h2>
    <p class="muted small">Money ${out ? 'moved from' : 'moved into'} ${item.books_name} ${out ? 'to' : 'from'} another of the company’s accounts (a card payment, savings, a loan).</p>
    <label class="field"><span>${out ? 'To account' : 'From account'}</span><select name="other" required><option value="">Choose…</option>
      ${transferTo.map(a => html`<option value="${a.account_id}">${a.name}</option>`)}</select></label>
    <p class="muted small">If the books already have this transfer (recorded from the other account), it’s matched instead of recorded again.${practice ? ' Practice copy: the other account’s bank line is left for you to match there.' : ''}</p>
    ${dupes.length ? html`<input type="hidden" name="evidence" value="${evidence}"><label class="check small"><input type="checkbox" name="separate" value="1"> This is a separate transaction (not one of the possible matches above)</label>` : ''}
    <div class="form-actions"><button class="primary">Record transfer</button></div>
  </form>
  <div class="card"><h2>Exclude</h2><p class="muted small">For duplicates and personal items: nothing goes into the books. You can undo it from the Excluded tab.</p>
    ${postButton({ action: `/banking/item/${item.item_id}/exclude`, csrf, label: 'Exclude', cls: '', extra: { rev } })}</div>` : ''}` });
}

// Match / Find match (stage BR-3): what's already in the books on this account (the near, same-amount ones, or a search),
// payments waiting to be deposited, open bills or invoices this line pays (each for an amount: part payments leave the rest
// open), and adjustment lines for a difference. One form; the live total shows what's chosen against the bank amount.
const FIND_TYPE_NAMES = { expense: 'Expense', check: 'Check', bill_payment: 'Bill payment', deposit: 'Deposit', payment: 'Payment', sales_receipt: 'Sales receipt',
  journal_entry: 'Journal entry', transfer: 'Transfer', cc_payment: 'Credit card payment', refund_receipt: 'Refund', cc_credit: 'Credit card credit' };
function matchCard({ csrf, item, revField, candidates, suggested, find, found, settleDocs, mv, out, cats = [] }) {
  const catText = x => (x && typeof x === 'object' ? cats.find(c => c.id === Number(x.id))?.value ?? '' : x ?? '');
  const target = Math.abs(Number(item.amount_cents));
  const sign = out ? -1 : 1;
  const ticked = id => (mv ? mv.txn.includes(String(id)) : suggested && Number(suggested.txn_id) === Number(id));
  const days = n => (n === 0 ? 'same day' : `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'before' : 'after'}`);
  const txnRow = (c, { reasons = false } = {}) => html`<li><label class="check"><input type="checkbox" name="txn" value="${c.txn_id}" data-cents="${sign * Number(c.amount_cents)}"${c.elsewhere ? html` disabled` : ticked(c.txn_id) ? html` checked` : ''}><input type="hidden" name="ver_${c.txn_id}" value="${c.version ?? ''}">
    ${txnLabel(c)}${c.party ? ` · ${c.party}` : ''} · ${formatShortDate(c.txn_date)} · ${formatCents(Math.abs(Number(c.amount_cents)))}${sign * Number(c.amount_cents) < 0 ? html` <small class="muted">(the other way)</small>` : ''}
    ${suggested && Number(suggested.txn_id) === Number(c.txn_id) ? html` <span class="tag ok">Suggested</span>` : ''}${c.checkConflict ? html` <span class="tag warn">Check number differs (bank: ${item.check_number})</span>` : c.sameCheck ? html` <span class="tag ok">Same check number</span>` : ''}
    ${reasons ? html` <small class="muted">${days(c.days)}</small>` : ''}${c.elsewhere ? html` <span class="tag">Already matched to <a href="/banking/item/${c.elsewhere}">another bank line</a></span>` : ''}</label> <a href="${linkOf(c)}" class="small">View</a></li>`;
  const list = found ? found.rows : [...candidates.exact, ...candidates.others];
  const adj = mv?.adj?.length ? mv.adj : [{}, {}];
  const shift = n => new Date(Date.parse(`${item.posted_date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const opts = (sel, all) => all.map(([k, label]) => html`<option value="${k}"${sel === k ? html` selected` : ''}>${label}</option>`);
  return html`<section class="card" id="match"><h2>Match</h2>
    <form method="get" action="/banking/item/${item.item_id}#match" class="find-form"><input type="hidden" name="find" value="1">
      <div class="form-grid">
        <label class="field"><span>Search</span><input name="q" value="${find?.q ?? ''}" placeholder="Payee, number or memo"></label>
        <label class="field"><span>From</span><input type="date" name="from" value="${found?.from ?? shift(-90)}"></label>
        <label class="field"><span>To</span><input type="date" name="to" value="${found?.to ?? shift(20)}"></label>
        <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" value="${find?.amount ?? ''}" placeholder="Any"></label>
        <label class="field"><span>Type</span><select name="type"><option value="">Any</option>${opts(find?.type ?? '', Object.entries(FIND_TYPE_NAMES))}</select></label>
      </div>
      <div class="form-actions"><button>Find</button>${find ? html`<a href="/banking/item/${item.item_id}#match">Clear</a>` : ''}</div>
    </form>
    <form method="post" action="/banking/item/${item.item_id}/match" data-settle data-target="${target}">${csrfField(csrf)}${revField}
      <p class="muted small">Tick what this bank item is. Together they must come to ${formatCents(target)}.</p>
      ${list.length ? html`<ul class="check-list">
        ${found ? list.map(c => txnRow(c, { reasons: true }))
          : html`${candidates.exact.map(c => txnRow(c))}${candidates.others.length ? html`<li class="muted small">Or several that together make ${formatCents(target)}:</li>` : ''}${candidates.others.map(c => txnRow(c))}`}</ul>`
        : html`<p class="muted">${found ? 'Nothing in the books on this account fits that search.' : `Nothing in the books has this amount on ${item.books_name} near this date.`} Search above, or pay an open ${out ? 'bill' : 'invoice'} below.</p>`}
      ${candidates.undeposited.length ? html`<h3>Waiting to be deposited</h3><ul class="check-list">${candidates.undeposited.map(u => html`<li><label class="check"><input type="checkbox" name="waiting" value="${u.txn_id}" data-cents="${Number(u.total_cents)}"${mv?.waiting.includes(String(u.txn_id)) ? html` checked` : ''}><input type="hidden" name="ver_${u.txn_id}" value="${u.version ?? ''}">
        ${TYPE_LABELS[u.type] ?? u.type}${u.doc_number ? ` ${u.doc_number}` : ''}${u.customer_name ? ` · ${u.customer_name}` : ''} · ${formatShortDate(u.txn_date)} · ${formatCents(Number(u.total_cents))}</label></li>`)}</ul>` : ''}
      ${settleDocs.length ? html`<h3>${out ? 'Open bills it pays' : 'Open invoices it pays'}</h3>
        <p class="muted small">Records a ${out ? 'bill payment' : 'received payment'} on ${item.books_name} dated ${formatShortDate(item.posted_date)}. Pay part of one by changing its amount.</p>
        <ul class="check-list settle-docs">${settleDocs.map(d => html`<li><label class="check"><input type="checkbox" name="pay" value="${d.txn_id}"${d.needs_approval ? html` disabled` : mv?.pay.has(String(d.txn_id)) ? html` checked` : ''}><input type="hidden" name="ver_${d.txn_id}" value="${d.version ?? ''}">
          ${txnLabel(d)}${d.party ? ` · ${d.party}` : ''} · ${d.due_date ? `due ${formatShortDate(d.due_date)}` : formatShortDate(d.txn_date)} · ${formatCents(d.open_cents)} open${d.open_cents !== d.total_cents ? ` of ${formatCents(d.total_cents)}` : ''}${d.needs_approval ? html` <span class="tag warn">Needs approval first</span>` : ''}</label>
          <input name="pay_amt_${d.txn_id}" class="pay-amount" inputmode="decimal" aria-label="Amount paid on ${txnLabel(d)}" value="${mv?.pay.get(String(d.txn_id)) ?? (Math.min(d.open_cents, target) / 100).toFixed(2)}"${d.needs_approval ? html` disabled` : ''}> <a href="${linkOf(d)}" class="small">View</a></li>`)}</ul>` : ''}
      <details class="adjust"${mv?.adj?.length ? html` open` : ''}><summary>Resolve a difference</summary>
        <p class="muted small">A bank fee, a discount or interest that makes up the difference: each line goes to a category in one journal entry on ${item.books_name}. A positive amount adds to what’s ticked, a negative one takes off.</p>
        ${adj.map((a, n) => html`<div class="split-line">
          <label class="field"><span>Category</span><input name="adj_account" list="item-cats" autocomplete="off" value="${catText(a.account)}"></label>
          <label class="field"><span>Amount</span><input name="adj_amount" inputmode="decimal" value="${a.amount ?? ''}" placeholder="${n ? '' : '-2.50'}"></label>
          <label class="field"><span>Description</span><input name="adj_description" value="${a.description ?? ''}"></label></div>`)}
      </details>
      <p class="settle-total small" data-settle-total aria-live="polite"></p>
      <div class="form-actions"><button class="primary">Match</button></div></form>
  </section>`;
}

// Categorization history (stage BR-4): the categories this payee went to — earlier bank reviews with the same description,
// and the books' own transactions with the vendor it names — with Assign to fill in the Add form.
function historyCard({ item, hist, cats }) {
  if (!hist?.rows.length) return '';
  const name = id => cats.find(c => c.id === Number(id))?.name ?? 'Account';
  const assign = id => `/banking/item/${item.item_id}?from=history&category=${id}${hist.vendor ? `&payee=v:${hist.vendor.id}` : ''}#add`;
  const count = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');
  return html`<section class="card bank-history"><h2>History</h2>
    <p class="muted small">How ${hist.vendor ? html`<strong>${hist.vendor.name}</strong>` : 'this payee'} was categorized before${hist.vendor ? ' — in bank reviews and in the books (last 24 months)' : ' in bank reviews'}.</p>
    <div class="table-scroll"><table class="grid"><thead><tr><th>Category</th><th>Used</th><th>Last</th><th class="actions"></th></tr></thead><tbody>
    ${hist.rows.slice(0, 8).map(r => html`<tr><td>${name(r.accountId)}
        ${r.examples.length ? html`<details class="small"><summary>Details</summary><ul>${r.examples.map(e => html`<li><a href="${linkOf(e)}">${txnLabel(e)}</a> · ${formatShortDate(e.txn_date)} · ${formatCents(Math.abs(Number(e.amount_cents)))}</li>`)}</ul></details>` : ''}</td>
      <td>${[count(r.bank, 'bank review', 'bank reviews'), count(r.books, 'in the books', 'in the books')].filter(Boolean).join(' · ')}</td>
      <td>${r.last ? formatShortDate(r.last) : '—'}</td>
      <td class="actions"><a class="button" href="${assign(r.accountId)}">Assign</a></td></tr>`)}</tbody></table></div>
  </section>`;
}

// Files and notes on the bank line (stage BR-7). Files go onto the transaction it becomes when that has a vendor or customer.
function filesAndNotes({ csrf, item, files, notes, canReview }) {
  const size = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return html`<div class="bank-extras">
    <h2 class="small-heading">Files</h2>
    ${files.length ? html`<ul class="small">${files.map(f => html`<li><a href="/banking/item/${item.item_id}/attachment/${f.attachment_id}">${f.filename}</a> · ${size(f.size_bytes)} · ${f.uploaded_by}
      ${f.filed_txn ? html` <span class="tag ok">On the transaction</span>` : ''}
      ${canReview ? postButton({ action: `/banking/item/${item.item_id}/attachment/${f.attachment_id}/delete`, csrf, label: 'Remove', confirm: `Remove “${f.filename}” from this bank item?${f.filed_txn ? ' The copy on the transaction stays.' : ''}` }) : ''}</li>`)}</ul>`
      : html`<p class="muted small">No files yet.${item.review_state === 'new' ? ' A receipt added here goes onto the transaction when the item is added.' : ''}</p>`}
    ${canReview ? html`<form method="post" action="/banking/item/${item.item_id}/attach" enctype="multipart/form-data" class="inline-form">${csrfField(csrf)}
      <input type="file" name="file" required aria-label="File to attach"> <button>Attach</button></form>` : ''}
    <h2 class="small-heading">Notes</h2>
    ${notes.length ? html`<ul class="small">${notes.map(n => html`<li>${n.note} <small class="muted">— ${n.actor}, ${formatShortDate(new Date(n.at).toISOString().slice(0, 10))}</small></li>`)}</ul>` : ''}
    ${canReview ? html`<form method="post" action="/banking/item/${item.item_id}/note" class="inline-form">${csrfField(csrf)}
      <input name="note" maxlength="1000" required placeholder="Add a note for whoever reviews this" aria-label="Note"> <button>Add note</button></form>` : ''}
  </div>`;
}

// Create a backdated bill (stage BR-7): the bill as the vendor sent it, paid by this bank line.
function billCard({ csrf, item, revField, typed, payeeList, dupes, evidence, canApprove, cats = [] }) {
  // A choice carried over after an error ({ id } / { key }) is shown with this page's label for that record.
  const catText = x => (x && typeof x === 'object' ? cats.find(c => c.id === Number(x.id))?.value ?? '' : x ?? '');
  const payeeText = x => (x && typeof x === 'object' ? payeeList.find(p => p.key === x.key)?.value ?? '' : x ?? '');
  const b = typed?.bill ?? {};
  const line = n => html`<div class="split-line">
    <label class="field"><span>${n ? `Category ${n + 1}` : 'Category'}</span><input name="bill_account" list="item-cats" autocomplete="off" value="${catText(b.lines?.[n]?.accountId)}"${n ? '' : html` required`}></label>
    <label class="field"><span>Amount</span><input name="bill_amount" inputmode="decimal" value="${b.lines?.[n]?.amount ?? ''}" placeholder="${n ? '' : (Math.abs(item.amount_cents) / 100).toFixed(2)}"></label>
    <label class="field"><span>Description</span><input name="bill_description" value="${b.lines?.[n]?.description ?? ''}"></label></div>`;
  return html`<details class="card"${typed?.bill ? html` open` : ''}><summary><h2 class="inline-heading">Create a bill</h2></summary>
    <form method="post" action="/banking/item/${item.item_id}/bill" class="editor" data-split data-target="${Math.abs(Number(item.amount_cents))}">${csrfField(csrf)}${revField}
      <p class="muted small">For a bill that wasn’t entered yet: records the bill on its own date and its payment from ${item.books_name} on ${formatShortDate(item.posted_date)}. Undo removes both.${canApprove ? '' : ' (If this company approves bills, someone who can approve them has to do this.)'}</p>
      <div class="form-grid">
        <label class="field"><span>Vendor</span><input name="bill_vendor" list="item-vendors" autocomplete="off" required value="${payeeText(b.payee)}"></label>
        <label class="field"><span>Bill date</span><input type="date" name="bill_date" required max="${item.posted_date}" value="${b.date ?? ''}"></label>
        <label class="field"><span>Bill no.</span><input name="bill_number" value="${b.number ?? ''}"></label>
      </div>
      <datalist id="item-vendors">${payeeList.filter(p => p.kind === 'Vendor').map(p => html`<option value="${p.value}"></option>`)}</datalist>
      <div data-split-lines>${Array.from({ length: Math.max(2, b.lines?.length ?? 0) }, (_, n) => line(n))}</div>
      <p class="settle-total small" data-split-total aria-live="polite"></p>
      <label class="field"><span>Memo</span><input name="bill_memo" value="${b.memo ?? ''}" placeholder="${item.description}"></label>
      ${dupes.length ? html`<input type="hidden" name="evidence" value="${evidence}"><label class="check small"><input type="checkbox" name="separate" value="1"> This is a separate transaction (not one of the possible matches above)</label>` : ''}
      <div class="form-actions"><button class="primary">Create bill and pay it</button></div>
    </form></details>`;
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
      <dt>Category</dt><dd>${r.category_name ?? (r.category_withheld ? html`<span class="muted">— (researched for a purchase of a different size: choose one)</span>` : '—')}</dd>
    </dl>
    ${p.reasons ? html`<p class="muted small">${p.reasons}</p>` : ''}
    ${r.sources.length ? html`<p class="small">Sources: ${r.sources.map((x, i) => html`${i ? ' · ' : ''}<a href="${x.url}" target="_blank" rel="noopener noreferrer nofollow">${x.title}</a>`)}</p>` : ''}
    ${Number(r.item_id) !== Number(item.item_id) ? html`<p class="muted small">From research on another item with the same payee.</p>` : ''}
    ${r.decision ? html`<p class="muted small">${r.decision === 'accepted' ? 'Accepted' : 'Rejected'} by ${r.decided_by}.</p>${r.decision === 'rejected' && ai.on ? ask('Research again') : ''}`
      : html`<div class="form-actions">${postButton({ action: `/banking/research/${r.research_id}/accept`, csrf, label: p.new_vendor && !r.vendor_name ? 'Accept and add the vendor' : 'Accept', cls: 'primary', extra: { item: item.item_id } })}
        ${postButton({ action: `/banking/research/${r.research_id}/reject`, csrf, label: 'Reject', cls: '', extra: { item: item.item_id } })}${ai.on ? ask('Research again') : ''}</div>`}`}
  </section>`;
}
