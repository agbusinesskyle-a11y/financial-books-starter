// Progressive enhancement only: every page works without this file. The server recomputes
// every amount on save; numbers shown here are previews.

const toCents = text => {
  const s = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return null;
  return Math.round(Number(s) * 100);
};
const money = cents => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const input = cents => (cents / 100).toFixed(2);

// ---- Transaction List filters ----
document.addEventListener('change', event => {
  const el = event.target;
  if (!(el instanceof HTMLSelectElement) || !el.hasAttribute('data-autosubmit')) return;
  const form = el.form;
  const custom = form.querySelector('.custom-dates');
  if (el.name === 'date' && custom) {
    custom.classList.toggle('hidden', el.value !== 'custom');
    if (el.value === 'custom') { custom.querySelector('input')?.focus(); return; }
  }
  form.requestSubmit();
});

// ---- print, confirm, select-all ----
document.addEventListener('click', event => {
  const t = event.target instanceof Element ? event.target : null;
  if (!t) return;
  if (t.closest('[data-print]')) window.print();
  if (t.matches('[data-select-all]')) {
    const name = t.getAttribute('data-select-all') || 'ids';
    document.querySelectorAll(`input[type=checkbox][name="${name}"]`).forEach(box => { box.checked = t.checked; });
    updateSelected();
    t.closest('form')?.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (t.matches('input[type=checkbox][name=ids]')) updateSelected();
});

function updateSelected() {
  const n = document.querySelectorAll('input[type=checkbox][name=ids]:checked').length;
  const label = document.querySelector('[data-selected-count]');
  if (!label) return;
  label.dataset.empty ??= label.textContent;
  label.textContent = n ? `${n} selected` : label.dataset.empty;
}

document.addEventListener('submit', event => {
  const form = event.target;
  const message = event.submitter?.getAttribute('data-confirm') || form.getAttribute('data-confirm');
  if (message && !window.confirm(message)) { event.preventDefault(); return; }
  if (message && form.method.toLowerCase() === 'post' && !form.querySelector('input[name=confirmed]')) {
    const ok = document.createElement('input'); ok.type = 'hidden'; ok.name = 'confirmed'; ok.value = '1'; form.append(ok);
  }
  // One tap is one save: disable the button just after the browser has taken its value (posting forms only).
  const b = event.submitter;
  const newTab = (b?.getAttribute('formtarget') || form.getAttribute('target')) === '_blank';
  if (b && form.method.toLowerCase() === 'post' && !newTab) setTimeout(() => { b.disabled = true; }, 0);
});
// Coming back to a page from history: buttons work again.
window.addEventListener('pageshow', () => document.querySelectorAll('button[disabled]:not([data-keep-disabled])').forEach(b => { b.disabled = false; }));

// A foreign-currency editor shows "EUR 1,234.00".
const fmtFor = form => (form.dataset.currency
  ? c => `${form.dataset.currency} ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : money);

// With multicurrency on, choosing a customer (or vendor) reloads the editor in their currency.
document.querySelectorAll('[data-reload-vendor]').forEach(form => {
  form.querySelector('[name=vendor_id]')?.addEventListener('change', event => {
    if (event.target.value) window.location.href = `${form.dataset.reloadVendor}&vendor=${encodeURIComponent(event.target.value)}`;
  });
});
// Only when the currency actually changes (each customer option says its currency), so typed lines aren't lost otherwise.
document.querySelectorAll('[data-reload-customer]').forEach(form => {
  form.querySelector('[name=customer_id]')?.addEventListener('change', event => {
    const next = event.target.selectedOptions[0]?.dataset.currency ?? '';
    if (event.target.value && next !== (form.dataset.currency ?? '')) window.location.href = `${form.dataset.reloadCustomer}&customer=${encodeURIComponent(event.target.value)}`;
  });
});

// ---- invoice / sales receipt / credit memo editor ----
function recalcEditor(editor) {
  let total = 0, section = 0;
  editor.querySelectorAll('[data-line]').forEach(row => {
    // A subtotal line shows the lines above it since the last subtotal (stage F3); text lines show nothing.
    const sub = row.querySelector('[data-subtotal-amount]');
    if (sub) { sub.textContent = fmtFor(editor)(section); section = 0; return; }
    if (!row.querySelector('[data-qty]')) return;
    const qtyText = row.querySelector('[data-qty]').value.trim();
    const qty = qtyText === '' ? 1 : Number(qtyText.replace(/,/g, ''));
    const rate = toCents(row.querySelector('[data-rate-input]').value);
    const cell = row.querySelector('[data-amount]');
    if (rate === null || !Number.isFinite(qty)) { cell.textContent = ''; return; }
    const amount = Math.round(qty * rate);
    cell.textContent = fmtFor(editor)(amount);
    total += amount;
    section += amount;
  });
  // Discount (percent or amount) and shipping, when Settings → Sales turns them on.
  const subtotal = total;
  const dValue = editor.querySelector('[data-discount-value]');
  if (dValue && dValue.value.trim()) {
    const percent = editor.querySelector('[data-discount-kind]')?.value === 'percent';
    const d = percent ? Math.round(subtotal * Number(dValue.value.replace('%', '')) / 100) : toCents(dValue.value);
    if (Number.isFinite(d) && d !== null) total -= d;
  }
  const ship = editor.querySelector('[data-shipping]');
  if (ship && ship.value.trim()) { const c = toCents(ship.value); if (c !== null) total += c; }
  const sub = editor.querySelector('[data-subtotal]');
  if (sub) sub.textContent = fmtFor(editor)(subtotal);
  editor.querySelectorAll('[data-total]').forEach(out => { out.textContent = fmtFor(editor)(total); });
  const dep = editor.querySelector('[data-deposit]'), due = editor.querySelector('[data-balance-due]');
  if (due) { const c = dep && dep.value.trim() ? toCents(dep.value) : 0; due.textContent = fmtFor(editor)(total - (c ?? 0)); }
}

function syncDueDate(editor) {
  const due = editor.querySelector('[data-due-date]');
  const terms = editor.querySelector('[data-terms]');
  const date = editor.querySelector('[data-txn-date]');
  if (!due || !terms || !date || due.dataset.touched || !terms.value || !date.value) return;
  const days = Number(terms.selectedOptions[0].dataset.days);
  const d = new Date(`${date.value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  due.value = d.toISOString().slice(0, 10);
}

document.querySelectorAll('[data-editor]').forEach(editor => {
  editor.addEventListener('input', event => {
    if (event.target.matches('[data-due-date]')) event.target.dataset.touched = '1';
    recalcEditor(editor);
  });
  editor.addEventListener('change', event => {
    const el = event.target;
    if (el.matches('[data-item]')) {
      const row = el.closest('[data-line]');
      const opt = el.selectedOptions[0];
      const rate = row.querySelector('[data-rate-input]'), desc = row.querySelector('[data-desc]'), qty = row.querySelector('[data-qty]');
      // Item prices are in USD; a foreign-currency editor converts them at its rate.
      const xr = Number(editor.querySelector('[name=exchange_rate]')?.value || editor.dataset.exchangeRate || 0);
      if (opt?.dataset.rate && !rate.value) rate.value = xr ? (Number(opt.dataset.rate) / xr).toFixed(2) : opt.dataset.rate;
      if (el.value && !desc.value) desc.value = opt.textContent;
      if (el.value && !qty.value) qty.value = '1';
    }
    if (el.matches('[data-terms], [data-txn-date]')) syncDueDate(editor);
    recalcEditor(editor);
  });
  // ---- line tools (stage F3) ----
  const body = editor.querySelector('[data-lines] tbody');
  const renumber = () => [...body.children].forEach((row, i) => {
    row.querySelector('.line-no').textContent = String(i + 1);
    row.querySelectorAll('[aria-label]').forEach(el => { el.setAttribute('aria-label', el.getAttribute('aria-label').replace(/line \d+$/, `line ${i + 1}`)); });
  });
  const template = kind => editor.querySelector(`template[data-row="${kind}"]`)?.content.firstElementChild?.cloneNode(true);
  const blankItemRow = () => {
    const t = template('item');
    if (t) return t;
    // Recurring templates have no row templates: clone an item row and empty it.
    const row = [...body.children].find(r => r.querySelector('[data-item]')).cloneNode(true);
    row.querySelectorAll('input').forEach(i => { if (i.type !== 'hidden' || i.name !== 'line_kind') i.value = ''; });
    row.querySelectorAll('select').forEach(sel => { sel.selectedIndex = 0; });
    row.querySelector('[data-amount]').textContent = '';
    row.querySelectorAll('[data-rule-note]').forEach(n => { n.textContent = ''; });
    return row;
  };
  const addRow = (row, after = null) => {
    if (after) after.after(row); else body.appendChild(row);
    renumber();
    recalcEditor(editor);
    return row;
  };
  editor.querySelector('[data-add-line]')?.addEventListener('click', () => addRow(blankItemRow()).querySelector('select, input:not([type=hidden])')?.focus());
  editor.querySelectorAll('[data-add-kind]').forEach(b => b.addEventListener('click', () => {
    const row = template(b.dataset.addKind);
    if (row) addRow(row).querySelector('[data-desc]')?.focus();
  }));
  editor.querySelector('[data-clear-lines]')?.addEventListener('click', () => {
    body.replaceChildren();
    addRow(blankItemRow());
    addRow(blankItemRow());
  });
  body.addEventListener('click', event => {
    const t = event.target instanceof Element ? event.target : null;
    const row = t?.closest('[data-line]');
    if (!row) return;
    if (t.closest('[data-dup-line]')) {
      const copy = row.cloneNode(true);
      // A select's chosen option isn't part of the copy; carry it over.
      row.querySelectorAll('select').forEach((sel, i) => { copy.querySelectorAll('select')[i].value = sel.value; });
      // A copied line isn't the same billed expense, time entry or estimate line.
      copy.querySelectorAll('input[name=line_bill], input[name=line_time], input[name=line_est]').forEach(i => { i.value = ''; });
      addRow(copy, row);
    } else if (t.closest('[data-del-line]')) {
      row.remove();
      if (![...body.children].some(r => r.querySelector('[data-item]'))) addRow(blankItemRow());
      renumber();
      recalcEditor(editor);
    }
  });
  // Typing in the last product line opens another blank one, as QBO does.
  body.addEventListener('input', event => {
    const row = event.target instanceof Element ? event.target.closest('[data-line]') : null;
    if (row && row === body.lastElementChild && row.querySelector('[data-item]')) addRow(blankItemRow());
  });
  // Rows copied from a spreadsheet: product or service, description, quantity, rate (tab- or comma-separated).
  editor.querySelector('[data-paste-apply]')?.addEventListener('click', () => {
    const box = editor.querySelector('[data-paste-lines]');
    const rows = box.value.replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(0, 100)
      .map(l => (l.includes('\t') ? l.split('\t') : l.split(',')).map(c => c.trim().replace(/^"(.*)"$/, '$1').replace(/^\$/, '')));
    // Fill empty product lines first, then add lines.
    const empty = () => [...body.children].find(r => r.querySelector('[data-item]') && !r.querySelector('[data-item]').value && !r.querySelector('[data-desc]').value && !r.querySelector('[data-rate-input]').value);
    for (const [name = '', desc = '', qty = '', rate = ''] of rows) {
      const row = empty() ?? addRow(blankItemRow());
      const sel = row.querySelector('[data-item]');
      const opt = [...sel.options].find(o => o.textContent.trim().toLowerCase() === name.toLowerCase());
      if (opt) sel.value = opt.value;
      row.querySelector('[data-desc]').value = desc || (opt ? opt.textContent.trim() : name);
      row.querySelector('[data-qty]').value = qty;
      row.querySelector('[data-rate-input]').value = rate || (opt?.dataset.rate ?? '');
    }
    box.value = '';
    box.closest('details')?.removeAttribute('open');
    recalcEditor(editor);
  });
  recalcEditor(editor);
});

// ---- receive payment / apply credit ----
function recalcPayment(form) {
  const received = toCents(form.querySelector('[data-amount-received]')?.value) ?? 0;
  let applied = 0;
  form.querySelectorAll('input[data-open]').forEach(i => { applied += toCents(i.value) ?? 0; });
  const out = form.querySelector('[data-unapplied]');
  if (out) {
    out.textContent = fmtFor(form)(received - applied);
    out.classList.toggle('negative', received - applied < 0);
  }
}

document.querySelectorAll('[data-payment]').forEach(form => {
  form.addEventListener('input', () => recalcPayment(form));
  form.querySelector('[data-auto-apply]')?.addEventListener('click', () => {
    let left = toCents(form.querySelector('[data-amount-received]')?.value) ?? 0;
    const boxes = [...form.querySelectorAll('input[data-open]')];
    if (left === 0) { // nothing typed yet: pay everything listed
      left = boxes.reduce((s, i) => s + toCents(i.dataset.open), 0);
      const amount = form.querySelector('input[data-amount-received]:not([type=hidden])');
      if (amount) amount.value = input(left);
    }
    boxes.forEach(i => {
      const take = Math.min(left, toCents(i.dataset.open));
      i.value = take > 0 ? input(take) : '';
      left -= take;
    });
    recalcPayment(form);
  });
  form.querySelector('[data-clear-apply]')?.addEventListener('click', () => {
    form.querySelectorAll('input[data-open]').forEach(i => { i.value = ''; });
    recalcPayment(form);
  });
  recalcPayment(form);
});

// ---- Settings → Email: provider preset fills server, port, security, and the username hint ----
document.querySelectorAll('[data-mail-settings]').forEach(form => {
  const preset = form.querySelector('[data-preset]');
  preset?.addEventListener('change', () => {
    const opt = preset.selectedOptions[0];
    if (!opt?.dataset.host) return;
    form.elements.host.value = opt.dataset.host;
    form.elements.port.value = opt.dataset.port;
    form.elements.security.value = opt.dataset.security;
    const label = form.elements.user.closest('label');
    let hint = label.querySelector('small');
    if (!hint) { hint = document.createElement('small'); hint.className = 'muted'; label.appendChild(hint); }
    hint.textContent = opt.dataset.hint;
    const smtp = form.querySelector('input[name=mode][value=smtp]');
    if (smtp) smtp.checked = true;
  });
});

// ---- Statements: open-item statements have no period; show the chosen type's description ----
document.querySelectorAll('[data-statement-form]').forEach(form => {
  const kind = form.querySelector('[data-statement-kind]');
  const sync = () => {
    form.querySelectorAll('.period').forEach(el => el.classList.toggle('hidden', kind.value === 'open_item'));
    const help = form.querySelector('[data-kind-help]');
    if (help) help.textContent = kind.selectedOptions[0]?.dataset.help ?? '';
  };
  kind?.addEventListener('change', sync);
});

// The header's email button links to #compose: open it and focus the subject.
if (location.hash === '#compose') {
  const compose = document.getElementById('compose');
  if (compose) { compose.open = true; compose.querySelector('input[name=subject]')?.focus(); }
}

// ---- Recurring template: schedule fields only for scheduled/reminder; auto-send only for scheduled ----
document.querySelectorAll('[data-recurring-form]').forEach(form => {
  const sync = () => {
    const mode = form.querySelector('[data-recurring-mode]:checked')?.value;
    form.querySelector('.schedule')?.classList.toggle('hidden', mode === 'unscheduled');
    form.querySelector('.schedule-send')?.classList.toggle('hidden', mode !== 'scheduled');
  };
  form.addEventListener('change', event => { if (event.target.matches('[data-recurring-mode]')) sync(); });
});

// ---- make deposit: running total ----
// Stage F6: choosing a file to upload on a bill / expense / check reads it straight away.
document.querySelectorAll('[data-upload-auto]').forEach(input => input.addEventListener('change', () => {
  if (input.files.length) { input.form.querySelector('button').textContent = 'Reading…'; input.form.submit(); }
}));

document.querySelectorAll('[data-deposit-form]').forEach(form => {
  const recalc = () => {
    let total = 0;
    form.querySelectorAll('input[name=source]:checked').forEach(box => { total += Number(box.dataset.amount) || 0; });
    form.querySelectorAll('[data-other-amount]').forEach(el => { total += toCents(el.value) ?? 0; });
    const cashBack = form.querySelector('[data-cash-back]');
    if (cashBack) total -= toCents(cashBack.value) ?? 0;
    form.querySelector('[data-deposit-total]').textContent = money(total);
  };
  form.addEventListener('input', recalc);
  form.addEventListener('change', recalc);
  recalc();
});

// ---- vendor editor (bill, expense, check, vendor credit): line amounts, total, add rows, product cost ----
const signedCents = text => {
  const t = String(text ?? '').trim();
  return t.startsWith('-') ? -(toCents(t.slice(1)) ?? 0) : (toCents(t) ?? 0);
};
const qtyOf = text => { const n = Number(String(text ?? '').replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };
document.querySelectorAll('[data-vendor-editor]').forEach(form => {
  const recalc = () => {
    let total = 0;
    form.querySelectorAll('[data-vamount]').forEach(el => { total += signedCents(el.value); });
    form.querySelectorAll('[data-rows="item"] tbody tr').forEach(row => {
      const qtyText = row.querySelector('[data-vqty]').value, rateText = row.querySelector('[data-vrate]').value;
      const cents = rateText.trim() ? Math.round(qtyOf(qtyText || '1') * (toCents(rateText) ?? 0)) : 0;
      row.querySelector('[data-vline]').textContent = cents ? money(cents) : '—';
      total += cents;
    });
    form.querySelector('[data-vtotal]').textContent = money(total);
  };
  form.addEventListener('input', recalc);
  form.addEventListener('change', event => {
    const sel = event.target;
    if (sel.name === 'item_item') {
      const row = sel.closest('tr'), cost = sel.selectedOptions[0]?.dataset.cost;
      const rate = row.querySelector('[data-vrate]');
      if (cost && !rate.value.trim()) rate.value = input(Number(cost));
      if (!row.querySelector('[data-vqty]').value.trim()) row.querySelector('[data-vqty]').value = '1';
    }
    recalc();
  });
  form.addEventListener('click', event => {
    const btn = event.target.closest('[data-add-row]');
    if (!btn) return;
    const body = form.querySelector(`[data-rows="${btn.dataset.addRow}"] tbody`);
    const row = body.lastElementChild.cloneNode(true);
    row.querySelectorAll('input').forEach(el => { el.value = ''; });
    row.querySelectorAll('select').forEach(el => { el.selectedIndex = 0; });
    const line = row.querySelector('[data-vline]');
    if (line) line.textContent = '—';
    body.appendChild(row);
    row.querySelector('select, input')?.focus();
  });
  recalc();
});

// ---- pay bills: a ticked bill pays its open amount unless you type something else ----
document.querySelectorAll('[data-pay-bills]').forEach(form => {
  const recalc = () => {
    let total = 0;
    form.querySelectorAll('input[name=bill]').forEach(box => {
      const row = box.closest('tr'), pay = row.querySelector('[data-pay]');
      if (box.checked) total += toCents(pay.value) ?? 0;
    });
    form.querySelector('[data-pay-total]').textContent = money(total);
  };
  form.addEventListener('change', event => {
    const el = event.target;
    if (el.name === 'bill') {
      const row = el.closest('tr'), pay = row.querySelector('[data-pay]'), credit = row.querySelector('[data-credit]');
      if (el.checked && !pay.value.trim()) pay.value = input(Number(el.dataset.open) - (toCents(credit?.value) ?? 0));
      if (!el.checked) { pay.value = ''; if (credit) credit.value = ''; }
    }
    if (el.matches('[data-pay], [data-credit]')) el.closest('tr').querySelector('input[name=bill]').checked = Boolean(el.value.trim()) || el.closest('tr').querySelector('input[name=bill]').checked;
    recalc();
  });
  form.addEventListener('input', recalc);
  form.addEventListener('click', event => {
    if (event.target.matches('[data-select-all="bill"]')) {
      // The page-wide select-all handler runs after this one; wait for it, then fill in amounts.
      setTimeout(() => form.querySelectorAll('input[name=bill]').forEach(box => box.dispatchEvent(new Event('change', { bubbles: true }))));
    }
  });
  recalc();
});

// ---- product form: inventory fields only for inventory items ----
document.querySelectorAll('[data-item-kind]').forEach(select => {
  const box = select.form.querySelector('[data-inventory-fields]');
  const sync = () => box?.classList.toggle('hidden', select.value !== 'inventory');
  select.addEventListener('change', sync);
  sync();
});

// ---- vendor recurring template: schedule fields only when it runs on a schedule; select-all on a shown link ----
document.querySelectorAll('select[data-mode]').forEach(select => {
  const box = select.form.querySelector('[data-schedule]');
  const sync = () => box?.classList.toggle('hidden', select.value === 'unscheduled');
  select.addEventListener('change', sync);
  sync();
});
document.querySelectorAll('[data-select-on-focus]').forEach(el => el.addEventListener('focus', () => el.select()));

// ---- list column picker (remembered in this browser) ----
document.querySelectorAll('table[data-columns]').forEach(table => {
  const storeKey = `fb.columns.${table.dataset.columns}`;
  let hidden = [];
  try { hidden = JSON.parse(localStorage.getItem(storeKey) || '[]'); } catch { hidden = []; }
  const apply = () => table.querySelectorAll('[data-col]').forEach(cell => cell.classList.toggle('col-hidden', hidden.includes(cell.dataset.col)));
  document.querySelectorAll('[data-col-toggle]').forEach(box => {
    box.checked = !hidden.includes(box.dataset.colToggle);
    box.addEventListener('change', () => {
      hidden = box.checked ? hidden.filter(k => k !== box.dataset.colToggle) : [...hidden, box.dataset.colToggle];
      localStorage.setItem(storeKey, JSON.stringify(hidden));
      apply();
    });
  });
  apply();
});
document.addEventListener('change', event => {
  if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-autosubmit-check')) event.target.form.requestSubmit();
});

// ---- phone layout: tables become cards; each cell is labeled with its column heading ----
document.querySelectorAll('table.grid').forEach(table => {
  const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach(row => {
    let col = 0;
    [...row.children].forEach(cell => {
      if (!cell.hasAttribute('data-label') && heads[col]) cell.setAttribute('data-label', heads[col]);
      col += Number(cell.getAttribute('colspan')) || 1;
    });
  });
});

// ---- installable app: cache static files only (pages and data always come from the server) ----
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---- price rules: fill the rule price when a product is picked, and say which rule applied ----
document.querySelectorAll('[data-editor][data-price-rules]').forEach(editor => {
  let rules = [];
  try { rules = JSON.parse(editor.dataset.priceRules); } catch { return; }
  const ruleFor = itemId => {
    const customer = Number(editor.querySelector('[name=customer_id]')?.value || 0);
    const date = editor.querySelector('[data-txn-date]')?.value || '';
    return rules.find(r => (!r.customers.length || r.customers.includes(customer)) && (!r.items.length || r.items.includes(itemId))
      && (!r.start || !date || r.start <= date) && (!r.end || !date || r.end >= date));
  };
  editor.addEventListener('change', event => {
    const el = event.target;
    if (!el.matches('[data-item]')) return;
    const row = el.closest('[data-line]');
    const note = row.querySelector('[data-rule-note]');
    const rate = row.querySelector('[data-rate-input]');
    const opt = el.selectedOptions[0];
    if (note) note.textContent = '';
    const rule = el.value ? ruleFor(Number(el.value)) : null;
    if (!rule || !opt?.dataset.rate) return;
    const base = toCents(opt.dataset.rate);
    let cents = rule.kind === 'fixed' ? rule.price : Math.round(base * (100 - rule.off) / 100);
    const xr = Number(editor.querySelector('[name=exchange_rate]')?.value || editor.dataset.exchangeRate || 0);
    if (xr) cents = Math.round(cents / xr);
    rate.value = (cents / 100).toFixed(2);
    if (note) note.textContent = `Price rule: ${rule.name}`;
    recalcEditor(editor);
  });
});

// ---- journal entry: debits, credits and the difference; add a line ----
document.querySelectorAll('[data-journal]').forEach(form => {
  const recalc = () => {
    let debits = 0, credits = 0;
    form.querySelectorAll('[data-je-debit]').forEach(i => { debits += toCents(i.value) ?? 0; });
    form.querySelectorAll('[data-je-credit]').forEach(i => { credits += toCents(i.value) ?? 0; });
    form.querySelector('[data-je-debits]').textContent = money(debits);
    form.querySelector('[data-je-credits]').textContent = money(credits);
    form.querySelector('[data-je-diff]').textContent = money(Math.abs(debits - credits));
  };
  form.addEventListener('input', recalc);
  form.addEventListener('click', event => {
    const btn = event.target.closest('[data-add-row]');
    if (!btn) return;
    const body = form.querySelector(`[data-rows="${btn.dataset.addRow}"] tbody`);
    const row = body.lastElementChild.cloneNode(true);
    row.querySelectorAll('input').forEach(el => { el.value = ''; });
    row.querySelectorAll('select').forEach(el => { el.selectedIndex = 0; });
    body.appendChild(row);
    row.querySelector('select')?.focus();
  });
  recalc();
});

// ---- reconcile: cleared balance and difference as boxes are ticked ----
document.querySelectorAll('[data-reconcile]').forEach(form => {
  const totals = form.querySelector('[data-beginning]');
  const beginning = Number(totals.dataset.beginning);
  const recalc = () => {
    let cleared = beginning;
    form.querySelectorAll('input[name=ids]:checked').forEach(b => { cleared += Number(b.dataset.amount); });
    form.querySelector('[data-cleared]').textContent = money(cleared);
    const raw = form.querySelector('[data-ending]').value.trim();
    const ending = raw.startsWith('-') ? (toCents(raw.slice(1)) === null ? null : -toCents(raw.slice(1))) : toCents(raw);
    const diff = form.querySelector('[data-rec-diff]');
    diff.textContent = ending === null ? '—' : money(ending - cleared);
    diff.classList.toggle('negative', ending !== null && ending !== cleared);
  };
  form.addEventListener('change', recalc);
  form.addEventListener('input', recalc);
  form.querySelector('[data-tick-all]')?.addEventListener('click', () => { form.querySelectorAll('input[name=ids]').forEach(b => { b.checked = true; }); recalc(); });
  form.querySelector('[data-untick-all]')?.addEventListener('click', () => { form.querySelectorAll('input[name=ids]').forEach(b => { b.checked = false; }); recalc(); });
  recalc();
});

// ---- Report options: editing a date switches the period to "Custom dates" ----
document.querySelectorAll('[data-report-options]').forEach(form => {
  const period = form.querySelector('[data-period]');
  form.querySelectorAll('[data-period-date]').forEach(d => d.addEventListener('change', () => { if (period) period.value = 'custom'; }));
});

// ---- App navigation (stage N1): All apps panel, flyouts, global search ----
// Without this file the menus still work: flyouts are <details>, All apps and Search are pages.
(() => {
  const panel = document.querySelector('.apps-panel');
  const wide = () => window.matchMedia('(min-width: 1400px)').matches;
  document.addEventListener('click', event => {
    const t = event.target instanceof Element ? event.target : null;
    if (!t) return;
    const toggle = t.closest('[data-panel-toggle]');
    if (toggle && panel && wide()) {
      event.preventDefault();
      const closed = panel.classList.toggle('closed');
      toggle.setAttribute('aria-expanded', String(!closed));
      document.cookie = `fb_panel=${closed ? 0 : 1}; path=/; max-age=31536000; samesite=lax`;
      return;
    }
    // Narrower screens: the panel opens over the page (phones go to the All apps page instead).
    if (toggle && panel && window.matchMedia('(min-width: 701px)').matches) {
      event.preventDefault();
      panel.classList.toggle('overlay');
      return;
    }
    if (panel?.classList.contains('overlay') && !panel.contains(t)) panel.classList.remove('overlay');
    // A click outside an open flyout closes it.
    document.querySelectorAll('details.fly[open], details.gear[open], details.company-switch[open]').forEach(d => { if (!d.contains(t)) d.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    panel?.classList.remove('overlay');
    document.querySelectorAll('details.fly[open], details.gear[open], details.company-switch[open]').forEach(d => { d.open = false; d.querySelector('summary')?.focus(); });
    const pop = document.querySelector('[data-search-pop]');
    if (pop) { pop.classList.add('hidden'); document.querySelector('[data-global-search]')?.setAttribute('aria-expanded', 'false'); }
  });

  // Global search: the first matches as you type; Enter opens the full results page.
  const box = document.querySelector('[data-global-search]');
  const pop = document.querySelector('[data-search-pop]');
  if (!box || !pop) return;
  let timer = null, seq = 0;
  const hide = () => { seq++; pop.classList.add('hidden'); box.setAttribute('aria-expanded', 'false'); box.removeAttribute('aria-activedescendant'); };
  const render = result => {
    pop.textContent = '';
    if (!result.sections.length || box.value.trim() !== result.q) { hide(); return; }
    for (const [title, rows] of result.sections) {
      const h = document.createElement('h3'); h.textContent = title; pop.append(h);
      for (const r of rows) {
        const a = document.createElement('a'); a.href = r.href; a.textContent = r.label; a.setAttribute('role', 'option'); a.id = `gs-${pop.childElementCount}`;
        if (r.detail) { const s = document.createElement('span'); s.className = 'muted small'; s.textContent = r.detail; a.append(s); }
        pop.append(a);
      }
    }
    const all = document.createElement('a'); all.href = `/search?q=${encodeURIComponent(result.q)}`; all.textContent = `See all results for “${result.q}”`;
    all.setAttribute('role', 'option'); all.id = 'gs-all';
    pop.append(all);
    pop.classList.remove('hidden');
    box.setAttribute('aria-expanded', 'true');
  };
  box.addEventListener('input', () => {
    clearTimeout(timer);
    const q = box.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const res = await fetch(`/search?format=json&q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
        if (res.ok && mine === seq) render(await res.json());
      } catch { /* offline: Enter still opens the results page */ }
    }, 180);
  });
  box.addEventListener('keydown', event => {
    const links = [...pop.querySelectorAll('a')];
    if (!links.length || pop.classList.contains('hidden') || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const i = links.findIndex(a => a.classList.contains('active'));
    links.forEach(a => a.classList.remove('active'));
    const next = links[(i + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length];
    next.classList.add('active');
    next.scrollIntoView({ block: 'nearest' });
    box.setAttribute('aria-activedescendant', next.id);
  });
  box.form.addEventListener('submit', event => {
    const active = pop.querySelector('a.active');
    if (active) { event.preventDefault(); window.location.href = active.href; }
  });
  document.addEventListener('click', event => { if (!box.form.contains(event.target)) hide(); });
})();

// ---- Customer page: collapse the customer list (remembered in this browser) ----
(() => {
  const layout = document.querySelector('[data-side-layout]');
  if (!layout) return;
  const set = collapsed => { layout.classList.toggle('side-collapsed', collapsed); try { localStorage.setItem('fb_side', collapsed ? '0' : '1'); } catch { /* private mode */ } };
  try { if (localStorage.getItem('fb_side') === '0') set(true); } catch { /* private mode */ }
  document.addEventListener('click', event => {
    const t = event.target instanceof Element ? event.target : null;
    if (t?.closest('[data-collapse-side]')) set(true);
    if (t?.closest('[data-expand-side]')) set(false);
  });
})();

// ---- Customer transaction list (stage C2): filters apply as soon as they change, so Apply is only for no-JS;
// the Selected total; copy buttons ----
document.documentElement.classList.add('js');
document.addEventListener('change', event => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox' || !(box.name === 'ids' || box.hasAttribute('data-select-all'))) return;
  const out = document.querySelector('[data-selected-total]');
  if (!out) return;
  const picked = [...document.querySelectorAll('input[type=checkbox][name=ids][data-amount]:checked')];
  out.textContent = picked.length ? `Selected total ${money(picked.reduce((s, b) => s + Number(b.dataset.amount), 0))}` : '';
});
document.addEventListener('click', event => {
  const t = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
  if (!t) return;
  navigator.clipboard?.writeText(t.getAttribute('data-copy')).then(() => { t.textContent = 'Copied'; }, () => {});
});
document.addEventListener('focusin', event => { if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-select-on-focus')) event.target.select(); });

// ---- Filter table rows as you type (Recurring tab's "Search by template name") ----
document.addEventListener('input', event => {
  const box = event.target;
  if (!(box instanceof HTMLInputElement) || !box.hasAttribute('data-filter-rows')) return;
  const q = box.value.trim().toLowerCase();
  document.querySelectorAll(`${box.getAttribute('data-filter-rows')} tbody tr`).forEach(tr => { tr.hidden = !!q && !(tr.dataset.filterText ?? '').includes(q); });
});

// ---- Saving the QBO way (stage F1): Ctrl+Alt+S save and new, Ctrl+Alt+D save and close, Ctrl+Alt+M save and send ----
document.addEventListener('keydown', event => {
  if (!event.ctrlKey || !event.altKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (!['s', 'd', 'm'].includes(key)) return;
  const forms = [...document.querySelectorAll('form')].filter(f => f.querySelector('.save-bar'));
  const form = (document.activeElement instanceof Element && document.activeElement.closest('form')?.querySelector('.save-bar') && document.activeElement.closest('form')) || (forms.length === 1 ? forms[0] : null);
  const button = form?.querySelector(`.save-bar button[data-shortcut="${key}"]`);
  if (!button) return;
  event.preventDefault();
  form.requestSubmit(button);
});
// The save menu closes when you click elsewhere.
document.addEventListener('click', event => {
  document.querySelectorAll('details.split-menu[open], details.more-menu[open]').forEach(d => { if (!(event.target instanceof Node) || !d.contains(event.target)) d.removeAttribute('open'); });
});

// ---- Sales form details (stage F4): changing the customer fills in their Cc, Bcc, Bill to and Ship to — unless you typed your own ----
document.querySelectorAll('[data-editor]').forEach(editor => {
  const customer = editor.querySelector('select[name=customer_id]');
  if (!customer || !editor.querySelector('.sales-details')) return;
  const fields = { cc: '[data-email-cc]', bcc: '[data-email-bcc]', bill: 'textarea[name=bill_to]', ship: 'textarea[name=ship_to]' };
  const last = {};
  const opt = () => customer.selectedOptions[0];
  for (const k of Object.keys(fields)) last[k] = opt()?.dataset[k] ?? '';
  customer.addEventListener('change', () => {
    for (const [k, sel] of Object.entries(fields)) {
      const el = editor.querySelector(sel);
      if (!el) continue;
      const next = opt()?.dataset[k] ?? '';
      if (!el.value.trim() || el.value === last[k]) el.value = next;
      last[k] = next;
    }
  });
});
