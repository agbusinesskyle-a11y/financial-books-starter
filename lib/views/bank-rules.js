import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatCents } from '../domain/money.js';
import { TEXT_OPS, AMOUNT_OPS } from '../bankfeed/rules.js';

// Banking → Rules (stage B4): the list, in the order they're tried, and the rule form.

const conditionText = c => (c.field === 'amount'
  ? `Amount ${AMOUNT_OPS[c.op]} ${formatCents(c.value)}${c.op === 'between' ? ` and ${formatCents(c.value2)}` : ''}`
  : `Description ${TEXT_OPS[c.op]} “${c.value}”`);

export function rulesPage({ entityName, csrf, flash, rules, payeeNames }) {
  return layout({ title: 'Bank rules', entityName, csrf, flash, body: html`<div class="crumbs"><a href="/banking">‹ Bank transactions</a></div>
  <div class="page-actions"><h1>Rules</h1><span class="spacer"></span><a class="button primary" href="/banking/rules/new">New rule</a></div>
  <p class="muted">Rules fill in bank items the same way every time. They’re tried in order (lowest number first); the first one that fits is used.
    A rule set to <strong>add automatically</strong> records items as they arrive — unless the books already have a match for them.</p>
  ${rules.length ? html`<div class="table-scroll"><table class="grid">
    <thead><tr><th class="num">Order</th><th>Rule</th><th>When</th><th>Then</th><th>How</th><th class="actions"></th></tr></thead>
    <tbody>${rules.map(r => html`<tr class="${r.active ? '' : 'muted'}">
      <td class="num">${r.priority}</td>
      <td><a href="/banking/rules/${r.rule_id}">${r.name}</a>${r.active ? '' : html`<small class="muted">Off</small>`}</td>
      <td>Money ${r.money === 'out' ? 'out of' : 'into'} ${r.feed_books_name ?? 'any account'}<small class="muted">${r.conditions.map(conditionText).join(r.match_all ? ' and ' : ' or ')}</small></td>
      <td>${r.account_name ?? ''}${r.payee ? html`<small class="muted">Payee: ${payeeNames.get(r.payee) ?? ''}</small>` : ''}${r.memo ? html`<small class="muted">Memo: ${r.memo}</small>` : ''}</td>
      <td>${r.mode === 'auto' ? html`<span class="tag ok">Adds automatically</span>${r.auto_added ? html`<small class="muted">${r.auto_added} added</small>` : ''}` : 'Suggests'}</td>
      <td class="actions">${postButton({ action: `/banking/rules/${r.rule_id}/delete`, csrf, label: 'Delete', confirm: `Delete the rule “${r.name}”? Items it already added stay.` })}</td>
    </tr>`)}</tbody></table></div>` : html`<div class="card"><p>No rules yet. Open a bank item and choose <strong>Make a rule from this item</strong>, or start a new one.</p></div>`}` });
}

export function ruleForm({ entityName, csrf, flash, rule = null, v, error = null, feeds, categories, payees, classes, locations }) {
  const conds = [...(v.conditions ?? []), { field: 'description', op: 'contains', value: '' }, { field: 'amount', op: 'more', value: '' }].slice(0, Math.max(3, (v.conditions ?? []).length + 1));
  const opt = (value, label, current) => html`<option value="${value}"${String(current ?? '') === String(value) ? html` selected` : ''}>${label}</option>`;
  return layout({ title: rule ? 'Edit rule' : 'New rule', entityName, csrf, flash, body: html`<div class="crumbs"><a href="/banking/rules">‹ Rules</a></div>
  <h1>${rule ? `Rule: ${rule.name}` : 'New rule'}</h1>
  <form method="post" action="${rule ? `/banking/rules/${rule.rule_id}` : '/banking/rules'}" class="card editor">${csrfField(csrf)}${errorBanner(error)}
    <div class="form-grid">
      <label class="field"><span>Rule name <span class="req">*</span></span><input name="name" value="${v.name ?? ''}" required></label>
      <label class="field"><span>Order</span><input name="priority" inputmode="numeric" value="${v.priority ?? 100}"><small class="muted">Lower numbers are tried first.</small></label>
    </div>
    <h2>Apply this to</h2>
    <div class="form-grid">
      <label class="field"><span>Money</span><select name="money">${opt('out', 'Money out', v.money)}${opt('in', 'Money in', v.money)}</select></label>
      <label class="field"><span>In</span><select name="llAccount">${opt('', 'All bank and card accounts', v.llAccount)}${feeds.map(f => opt(f.id, f.books_name, v.llAccount))}</select></label>
      <label class="field"><span>When</span><select name="matchAll">${opt('1', 'All conditions fit', v.matchAll === false ? '0' : '1')}${opt('0', 'Any condition fits', v.matchAll === false ? '0' : '1')}</select></label>
    </div>
    ${conds.map((c, i) => html`<div class="split-line rule-condition">
      <label class="field"><span>Condition ${i + 1}</span><select name="cond_field">${opt('description', 'Description', c.field)}${opt('amount', 'Amount', c.field)}</select></label>
      <label class="field"><span>Compare</span><select name="cond_op">
        <optgroup label="Description">${Object.entries(TEXT_OPS).map(([k, l]) => opt(k, l, c.op))}</optgroup>
        <optgroup label="Amount">${Object.entries(AMOUNT_OPS).map(([k, l]) => opt(k, l, c.op))}</optgroup></select></label>
      <label class="field"><span>Value</span><input name="cond_value" value="${c.field === 'amount' && typeof c.value === 'number' ? (c.value / 100).toFixed(2) : c.value ?? ''}">
        <input name="cond_value2" aria-label="And (for between)" placeholder="and… (between)" value="${typeof c.value2 === 'number' ? (c.value2 / 100).toFixed(2) : c.value2 ?? ''}"></label>
    </div>`)}
    <h2>Then</h2>
    <div class="form-grid">
      <label class="field"><span>Payee</span><select name="payee">${opt('', '(none)', v.payee)}${payees.map(p => opt(p.key, p.name, v.payee))}</select></label>
      <label class="field"><span>Category</span><select name="accountId">${opt('', 'Choose…', v.accountId)}
        ${categories.map(([group, list]) => html`<optgroup label="${group}">${list.map(a => opt(a.account_id, a.name, v.accountId))}</optgroup>`)}</select></label>
      ${classes.length ? html`<label class="field"><span>Class</span><select name="classId">${opt('', '(none)', v.classId)}${classes.map(c => opt(c.class_id, c.name, v.classId))}</select></label>` : ''}
      ${locations.length ? html`<label class="field"><span>Location</span><select name="locationId">${opt('', '(none)', v.locationId)}${locations.map(l => opt(l.location_id, l.name, v.locationId))}</select></label>` : ''}
      <label class="field"><span>Memo</span><input name="memo" value="${v.memo ?? ''}"></label>
      <label class="field"><span>How</span><select name="mode">${opt('suggest', 'Suggest — I review each item', v.mode)}${opt('auto', 'Add automatically', v.mode)}</select></label>
    </div>
    <label class="check"><input type="checkbox" name="active" value="1"${v.active === false ? '' : html` checked`}> Rule is on</label>
    <div class="form-actions"><button class="primary">Save rule</button><a href="/banking/rules">Cancel</a></div>
  </form>` });
}
