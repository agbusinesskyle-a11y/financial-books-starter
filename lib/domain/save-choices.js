// How each form can be saved (stage F1, QBO's split save button). The first choice is the form's usual main button;
// people's last choice becomes their main button for that form. Keyboard: Ctrl+Alt+S save and new, Ctrl+Alt+D save and
// close, Ctrl+Alt+M save and send.

export const FORM_SAVE = {
  invoice: { verb: 'Save', choices: ['close', 'new', 'save', 'send'] },
  estimate: { verb: 'Save', choices: ['save', 'new', 'close', 'send'] },
  sales_receipt: { verb: 'Record', choices: ['close', 'new', 'send'] },
  credit_memo: { verb: 'Save', choices: ['close', 'new', 'send'] },
  payment: { verb: 'Record', choices: ['close', 'new'] },
  bill: { verb: 'Save', choices: ['close', 'new', 'submit', 'schedule'] },
  expense: { verb: 'Save', choices: ['close', 'new'] },
  cc_credit: { verb: 'Save', choices: ['close', 'new'] },
  check: { verb: 'Save', choices: ['close', 'new', 'print'] },
  vendor_credit: { verb: 'Save', choices: ['close', 'new'] },
  item_receipt: { verb: 'Save', choices: ['close', 'new'] },
  purchase_order: { verb: 'Save', choices: ['close', 'new', 'send'] },
  journal_entry: { verb: 'Save', choices: ['close', 'new'] },
  transfer: { verb: 'Save', choices: ['close', 'new'] },
  cc_payment: { verb: 'Save', choices: ['close', 'new'] },
  deposit: { verb: 'Save', choices: ['close', 'new', 'print'] },
};

export const SHORTCUT = { new: 'S', close: 'D', send: 'M' };

export function choiceLabel(type, choice) {
  const verb = FORM_SAVE[type]?.verb ?? 'Save';
  return { close: `${verb} and close`, new: `${verb} and new`, save: verb, send: `${verb} and send`, print: `${verb} and print`,
    submit: 'Save and submit for approval', schedule: 'Save and schedule payment' }[choice];
}

// The choice a submitted form asked for: its `then` button, or (older forms) after_save; else the form's main button.
export function chosen(form, type) {
  const allowed = FORM_SAVE[type]?.choices ?? ['close'];
  const then = form.get('then');
  if (allowed.includes(then)) return then;
  const legacy = { email: 'send', none: 'close' }[form.get('after_save')];
  if (legacy && allowed.includes(legacy)) return legacy;
  if (form.get('after_save') === 'print') return 'print';
  return allowed[0];
}

// Order for the button: the person's preferred choice first, then the rest in the form's order.
export function ordered(type, preferred) {
  const all = FORM_SAVE[type]?.choices ?? ['close'];
  return all.includes(preferred) ? [preferred, ...all.filter(c => c !== preferred)] : all;
}

// Where "close" goes back to: a page of this app the form came from (never another site).
export const safeBack = back => (typeof back === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(back) && !/^\/(login|logout)/.test(back) ? back : null);
