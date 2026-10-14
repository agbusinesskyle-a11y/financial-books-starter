import { addDays } from '../domain/dates.js';

// Deterministic sample books for "Sample Feed Co.": same { asOf, seed } -> identical output.
// Every name, address, and number here is made up.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TERMS = [
  { key: 'due', name: 'Due on receipt', due_days: 0 },
  { key: 'net15', name: 'Net 15', due_days: 15 },
  { key: 'net30', name: 'Net 30', due_days: 30 },
];

const ITEMS = [
  { key: 'cubes', name: 'Range Cubes 20% (ton)', kind: 'product', rate_cents: 48500, qty: [2, 12], income: 'feed_sales' },
  { key: 'horse', name: 'Horse Feed 14% (50 lb)', kind: 'product', rate_cents: 1995, qty: [20, 120], income: 'feed_sales' },
  { key: 'tub', name: 'Mineral Tub (250 lb)', kind: 'product', rate_cents: 13900, qty: [2, 16], income: 'feed_sales' },
  { key: 'hay', name: 'Coastal Hay Round Bale', kind: 'product', rate_cents: 8500, qty: [10, 60], income: 'hay_sales' },
  { key: 'alfalfa', name: 'Alfalfa Square Bale', kind: 'product', rate_cents: 1650, qty: [20, 150], income: 'hay_sales' },
  { key: 'freight', name: 'Delivery', kind: 'service', rate_cents: 15000, qty: [1, 1], income: 'delivery_income' },
  { key: 'late_fee', name: 'Late Fee', kind: 'system', rate_cents: 0, qty: [1, 1], income: null },
];

// Who the feed store buys from. All made up.
const VENDORS = [
  { key: 'hayfarm', display_name: 'Panhandle Hay Co.', company_name: 'Panhandle Hay Co.', email: 'office@panhandlehay.example', phone: '(806) 555-0112',
    street: 'PO Box 156', city: 'Dalhart', state: 'TX', postal: '79022', terms: 'net30', expense: 'hay_purchases', track_1099: false, notes: 'Round bales delivered Tue/Fri' },
  { key: 'mill', display_name: 'Lone Star Feed Mill', company_name: 'Lone Star Feed Mill, Inc.', email: 'ar@lonestarmill.example', phone: '(254) 555-0190',
    street: '900 Elevator Rd', city: 'Waco', state: 'TX', postal: '76705', terms: 'net15', expense: 'feed_purchases', track_1099: false, account_no: 'SFC-2210' },
  { key: 'fuel', display_name: 'Brazos Valley Fuel', company_name: 'Brazos Valley Fuel LLC', email: 'billing@bvfuel.example', phone: '(940) 555-0133',
    street: '12 Depot St', city: 'Gainesville', state: 'TX', postal: '76240', terms: 'due', expense: 'fuel', track_1099: false },
  { key: 'trucking', display_name: 'Cross Plains Trucking', company_name: null, email: 'dispatch@crossplainstrucking.example', phone: '(940) 555-0161',
    street: '3300 County Rd 210', city: 'Muenster', state: 'TX', postal: '76252', terms: 'net15', expense: 'freight_in', track_1099: true },
  { key: 'electric', display_name: 'Texoma Electric Co-op', company_name: 'Texoma Electric Cooperative', email: 'billing@texomaelectric.example', phone: '(903) 555-0100',
    street: '1 Co-op Way', city: 'Sherman', state: 'TX', postal: '75090', terms: 'net15', expense: 'utilities', track_1099: false, account_no: '0044-7781' },
  { key: 'landlord', display_name: 'Mill Road Properties', company_name: 'Mill Road Properties LLC', email: 'rent@millroadprops.example', phone: '(940) 555-0145',
    street: '220 Commerce St', city: 'Gainesville', state: 'TX', postal: '76240', terms: 'due', expense: 'rent', track_1099: true },
  { key: 'insurance', display_name: 'Prairie Mutual Insurance', company_name: 'Prairie Mutual Insurance Co.', email: 'service@prairiemutual.example', phone: '(800) 555-0177',
    street: '400 Main St Ste 900', city: 'Fort Worth', state: 'TX', postal: '76102', terms: 'net30', expense: 'insurance', track_1099: false },
  { key: 'repair', display_name: 'Red Dirt Equipment Repair', company_name: null, email: 'jake@reddirtrepair.example', phone: '(940) 555-0188',
    street: '5150 US-82', city: 'Lindsay', state: 'TX', postal: '76250', terms: 'net15', expense: 'repairs', track_1099: true, notes: 'Jake does forklift and skid steer work' },
  { key: 'office', display_name: 'Main Street Office Supply', company_name: null, email: 'orders@mainstoffice.example', phone: '(940) 555-0109',
    street: '108 N Dixon St', city: 'Gainesville', state: 'TX', postal: '76240', terms: 'net30', expense: 'office', track_1099: false },
];

// The company's own accounts (the built-in system accounts are added by the ledger).
const ACCOUNTS = [
  { key: 'checking', name: 'Operating Checking', number: '1010', type: 'bank' },
  { key: 'savings', name: 'Savings', number: '1020', type: 'bank' },
  { key: 'equipment', name: 'Equipment', number: '1500', type: 'fixed_asset' },
  { key: 'card', name: 'Business Card', number: '2100', type: 'credit_card' },
  { key: 'equipment_loan', name: 'Equipment Loan', number: '2500', type: 'long_term_liability' },
  { key: 'owner_equity', name: 'Owner’s Equity', number: '3000', type: 'equity' },
  { key: 'feed_sales', name: 'Feed Sales', number: '4010', type: 'income' },
  { key: 'hay_sales', name: 'Hay Sales', number: '4020', type: 'income' },
  { key: 'delivery_income', name: 'Delivery Income', number: '4030', type: 'income' },
  { key: 'feed_purchases', name: 'Feed Purchases', number: '5010', type: 'cost_of_goods_sold' },
  { key: 'hay_purchases', name: 'Hay Purchases', number: '5020', type: 'cost_of_goods_sold' },
  { key: 'freight_in', name: 'Freight In', number: '5100', type: 'cost_of_goods_sold' },
  { key: 'fuel', name: 'Fuel', number: '6100', type: 'expense' },
  { key: 'repairs', name: 'Repairs & Maintenance', number: '6200', type: 'expense' },
  { key: 'utilities', name: 'Utilities', number: '6400', type: 'expense' },
  { key: 'rent', name: 'Rent', number: '6500', type: 'expense' },
  { key: 'insurance', name: 'Insurance', number: '6600', type: 'expense' },
  { key: 'office', name: 'Office Supplies', number: '6700', type: 'expense' },
  { key: 'bank_fees', name: 'Bank Fees', number: '6800', type: 'expense' },
  { key: 'interest_income', name: 'Interest Income', number: '7010', type: 'other_income' },
  { key: 'interest_expense', name: 'Interest Expense', number: '8010', type: 'other_expense' },
];

// lag: days after due date the customer pays (negative = early). Profiles drive the story the page tells.
const CUSTOMERS = [
  { key: 'redriver', display_name: 'Red River Farm & Ranch', contact: 'Dale Whitaker', email: 'dale@redriverfarm.example', phone: '(940) 555-0141',
    street: '4120 FM 455', city: 'Sanger', note_line: 'Ask for Marla in the office, ext 2', terms: 'net15', every: 4, basket: ['cubes', 'tub', 'freight'], lag: [10, 55], slowLast: 120 },
  { key: 'prairie', display_name: 'Prairie Creek Feed Store', contact: 'Ana Ruiz', email: 'orders@prairiecreekfeed.example', phone: '(940) 555-0177',
    street: '88 Main St', city: 'Krum', note_line: 'Deliveries before 10am only', terms: 'net30', every: 7, basket: ['horse', 'alfalfa', 'freight'], lag: [-5, 6], voidOne: true },
  { key: 'loneoak', display_name: 'Lone Oak Cattle Co.', contact: 'Russ Henley', email: 'russ@loneoakcattle.example', phone: '(903) 555-0108',
    street: '2200 County Rd 1310', city: 'Whitesboro', terms: 'net15', every: 14, basket: ['cubes', 'hay', 'freight'], lag: [0, 20], partialOne: true },
  { key: 'bluebonnet', display_name: 'Bluebonnet Equine', contact: 'Jenna Cole', email: 'jenna@bluebonnetequine.example', phone: '(817) 555-0123',
    street: '15 Stable Ln', city: 'Argyle', terms: 'due', every: 21, basket: ['horse', 'alfalfa'], lag: [0, 3], salesReceipts: true },
  { key: 'crosstimbers', display_name: 'Cross Timbers Co-op', contact: 'Walt Briggs', email: 'ap@crosstimberscoop.example', phone: '(940) 555-0190',
    street: '501 Depot St', city: 'Valley View', terms: 'net30', every: 7, basket: ['cubes', 'horse', 'tub', 'freight'], lag: [-3, 8], creditMemo: true },
  { key: 'hilltop', display_name: 'Hilltop Dairy', contact: 'Priya Natarajan', email: 'priya@hilltopdairy.example', phone: '(254) 555-0164',
    street: '7790 Hwy 6', city: 'Hico', note_line: 'PO number required on every invoice', terms: 'net15', every: 14, basket: ['hay', 'alfalfa', 'tub'], lag: [5, 70], slowLast: 150 },
  { key: 'brazos', display_name: 'Brazos Valley Livestock', contact: 'Tom Aguilar', email: 'tom@brazosvalleylivestock.example', phone: '(979) 555-0132',
    street: '1200 Auction Barn Rd', city: 'Navasota', terms: 'net30', every: 30, basket: ['cubes', 'hay', 'freight'], lag: [-2, 10], prepay: true },
  { key: 'pecanbend', display_name: 'Pecan Bend Ranch', contact: 'Lou Ferris', email: 'lou@pecanbendranch.example', phone: '(325) 555-0119',
    street: '9 Pecan Bend Rd', city: 'Goldthwaite', terms: 'net15', every: 21, basket: ['hay', 'cubes'], lag: [0, 10], inactive: true },
];

// What the feed store buys and how it pays: [vendor, type, every N days, low, high, account, terms days, paid from, method].
const SPENDING = [
  { vendor: 'hayfarm', type: 'bill', every: 7, lo: 400000, hi: 700000, account: 'hay_purchases', memo: 'Round bales', terms: 30, payLag: [-3, 0] },
  { vendor: 'mill', type: 'bill', every: 10, lo: 300000, hi: 900000, account: 'feed_purchases', memo: 'Feed delivery', terms: 15, payLag: [0, 6], lateTail: 3 },
  { vendor: 'trucking', type: 'bill', every: 14, lo: 40000, hi: 90000, account: 'freight_in', memo: 'Freight', terms: 15, payLag: [-2, 2] },
  { vendor: 'electric', type: 'bill', every: 30, lo: 60000, hi: 95000, account: 'utilities', memo: 'Electric service', terms: 15, payLag: [-5, -1] },
  { vendor: 'insurance', type: 'bill', every: 91, lo: 240000, hi: 240000, account: 'insurance', memo: 'Quarterly premium', terms: 30, payLag: [-10, -5] },
  { vendor: 'repair', type: 'bill', every: 45, lo: 30000, hi: 150000, account: 'repairs', memo: 'Equipment repair', terms: 15, payLag: [0, 3] },
  { vendor: 'landlord', type: 'check', every: 30, lo: 350000, hi: 350000, account: 'rent', memo: 'Warehouse rent', from: 'checking' },
  { vendor: 'fuel', type: 'expense', every: 7, lo: 15000, hi: 45000, account: 'fuel', memo: 'Delivery truck fuel', from: 'card', method: 'Credit card' },
  { vendor: 'office', type: 'expense', every: 30, lo: 5000, hi: 20000, account: 'office', memo: 'Office supplies', from: 'card', method: 'Credit card' },
];

// Six months of bills, checks and expenses, and the bill payments that paid them (by check, in weekly runs).
function generateSpending(asOf, rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const docs = [], payments = [];
  for (const sp of SPENDING) {
    const vendorDocs = [];
    for (let d = addDays(asOf, -180 + int(0, 6)); d <= asOf; d = addDays(d, sp.every)) {
      const amount = Math.round(int(sp.lo, sp.hi) / 100) * 100;
      vendorDocs.push({ key: `${sp.vendor}-${sp.type}-${d}`, type: sp.type, vendor: sp.vendor, txn_date: d,
        due_date: sp.type === 'bill' ? addDays(d, sp.terms) : null, doc_number: sp.type === 'bill' ? `${sp.vendor.slice(0, 2).toUpperCase()}-${d.replace(/-/g, '').slice(2)}` : null,
        account: sp.from ?? null, method: sp.method ?? (sp.type === 'check' ? 'Check' : null), memo: sp.memo, approval: sp.type === 'bill' ? 'approved' : null,
        lines: [{ account: sp.account, description: sp.memo, amount_cents: amount }], total_cents: amount, open_cents: sp.type === 'bill' ? amount : 0 });
    }
    // Bills are paid around their due date; the mill's last few run late, and the newest hay bills wait for approval.
    if (sp.type === 'bill') {
      const lateFrom = sp.lateTail ? vendorDocs.length - sp.lateTail : Infinity;
      vendorDocs.forEach((b, i) => {
        if (sp.vendor === 'hayfarm' && i >= vendorDocs.length - 2) { b.approval = 'awaiting'; return; }
        if (i >= lateFrom) return;
        let pay = addDays(b.due_date, int(sp.payLag[0], sp.payLag[1]));
        if (pay < b.txn_date) pay = b.txn_date;
        const friday = addDays(pay, (12 - new Date(`${pay}T00:00:00Z`).getUTCDay()) % 7);
        if (friday > addDays(asOf, -2)) return;
        b.payDate = friday;
      });
    }
    docs.push(...vendorDocs);
  }
  // One bill payment per vendor per Friday run.
  const runs = new Map();
  for (const b of docs.filter(x => x.payDate)) {
    const k = `${b.vendor}|${b.payDate}`;
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(b);
  }
  for (const [k, bills] of runs) {
    const [vendor, date] = k.split('|');
    const total = bills.reduce((s, b) => s + b.open_cents, 0);
    payments.push({ key: `pay-${k}`, vendor, txn_date: date, account: 'checking', method: 'Check', total_cents: total,
      applies: bills.map(b => ({ bill: b.key, amount_cents: b.open_cents })) });
    for (const b of bills) b.open_cents = 0;
  }
  // A returned part from the repair shop, not used yet.
  docs.push({ key: 'repair-credit', type: 'vendor_credit', vendor: 'repair', txn_date: addDays(asOf, -12), due_date: null, doc_number: 'RD-CR1',
    account: null, method: null, memo: 'Returned unused hydraulic hose', approval: null,
    lines: [{ account: 'repairs', description: 'Returned part', amount_cents: 15000 }], total_cents: 15000, open_cents: 15000 });
  // Check numbers in date order across rent checks and bill payments (all on Operating Checking).
  const checks = [...docs.filter(x => x.type === 'check'), ...payments].sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.key < b.key ? -1 : 1));
  checks.forEach((c, i) => { c.doc_number = String(4001 + i); c.printed = c.txn_date < addDays(asOf, -3); });
  return { docs, payments };
}

const at = (date, hourUtc) => `${date}T${String(hourUtc).padStart(2, '0')}:00:00Z`;

export function generateSample({ asOf, seed = 42 }) {
  const rand = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const termsDays = Object.fromEntries(TERMS.map(t => [t.key, t.due_days]));
  const itemByKey = Object.fromEntries(ITEMS.map(i => [i.key, i]));

  const customers = CUSTOMERS.map(c => ({
    key: c.key, display_name: c.display_name, company_name: c.display_name, email: c.email, phone: c.phone,
    mobile: null, contact: c.contact,
    billing_address: { line1: c.street, city: c.city, state: 'TX', postal: String(75000 + int(0, 4999)) },
    shipping_address: null, shipping_same_as_billing: true, note_line: c.note_line ?? null, terms: c.terms,
    tax_exempt: true, tax_exempt_reason: 'Agricultural exemption', preferred_payment_method: c.salesReceipts ? 'Credit card' : 'Check',
    preferred_delivery: 'email', late_fees_enabled: true, active: !c.inactive,
  }));

  const txns = [], lines = [], applications = [], activity = [];
  let ticket = 1100, order = 100, check = 10200;

  for (const profile of CUSTOMERS) {
    const start = addDays(asOf, -730 + int(0, 10));
    const end = profile.inactive ? addDays(asOf, -380) : asOf;
    const charges = [];
    for (let d = start; d <= end; d = addDays(d, Math.max(1, profile.every + int(-2, 2)))) {
      const asReceipt = profile.salesReceipts && rand() < 0.7;
      const key = `${profile.key}-${txns.length}`;
      const picks = profile.basket.filter((_, i) => i === 0 || rand() < 0.6);
      let total = 0;
      picks.forEach((itemKey, i) => {
        const item = itemByKey[itemKey];
        const qty = int(item.qty[0], item.qty[1]);
        const amount = qty * item.rate_cents;
        total += amount;
        lines.push({ txn: key, line_no: i + 1, item: itemKey, description: item.name, quantity: qty, rate_cents: item.rate_cents, amount_cents: amount });
      });
      const memo = `Ticket ${ticket++} · ORD-${String(order++).padStart(4, '0')}`;
      if (asReceipt) {
        txns.push({ key, customer: profile.key, type: 'sales_receipt', txn_date: d, due_date: null, memo,
          payment_method: 'Credit card', payment_ref: null, total_cents: total, open_cents: 0, voided: false });
        continue;
      }
      const inv = { key, customer: profile.key, type: 'invoice', txn_date: d, due_date: addDays(d, termsDays[profile.terms]), memo,
        payment_method: null, payment_ref: null, total_cents: total, open_cents: total, voided: false };
      txns.push(inv);
      charges.push(inv);
    }

    if (profile.voidOne && charges.length > 20) {
      const v = charges.splice(charges.length - 15, 1)[0];
      v.voided = true; v.total_cents = 0; v.open_cents = 0;
    }

    if (profile.creditMemo && charges.length > 10) {
      const target = charges[charges.length - 12];
      const amount = Math.min(target.open_cents, 7980);
      const cm = { key: `${profile.key}-cm`, customer: profile.key, type: 'credit_memo', txn_date: addDays(target.txn_date, 3), due_date: null,
        memo: 'Returned 4 damaged bags', payment_method: null, payment_ref: null, total_cents: amount, open_cents: 0, voided: false };
      txns.push(cm);
      lines.push({ txn: cm.key, line_no: 1, item: 'horse', description: 'Returned damaged bags', quantity: 4, rate_cents: 1995, amount_cents: amount });
      applications.push({ credit: cm.key, charge: target.key, amount_cents: amount, applied_on: cm.txn_date });
      target.open_cents -= amount;
    }

    // Payments: each charge gets a pay date; charges paid in the same week are one check.
    const runs = new Map();
    for (const c of charges) {
      if (c.voided || c.open_cents === 0) continue;
      const slow = profile.slowLast && c.txn_date > addDays(asOf, -profile.slowLast);
      const lag = slow ? int(profile.lag[1], profile.lag[1] + 60) : int(profile.lag[0], profile.lag[1]);
      let payDate = addDays(c.due_date, lag);
      if (payDate < c.txn_date) payDate = c.txn_date;
      if (payDate > asOf) continue;
      const week = addDays(payDate, (7 - new Date(`${payDate}T00:00:00Z`).getUTCDay()) % 7); // next Sunday
      const runDate = week > asOf ? asOf : week;
      if (!runs.has(runDate)) runs.set(runDate, []);
      runs.get(runDate).push(c);
    }
    const runDates = [...runs.keys()].sort();
    runDates.forEach((runDate, i) => {
      const paid = runs.get(runDate);
      const isPartial = profile.partialOne && i === runDates.length - 3;
      const pay = { key: `${profile.key}-pay-${runDate}`, customer: profile.key, type: 'payment', txn_date: runDate, due_date: null,
        memo: null, payment_method: 'Check', payment_ref: `Check ${check++}`, total_cents: 0, open_cents: 0, voided: false };
      paid.forEach((c, j) => {
        const amount = isPartial && j === paid.length - 1 ? Math.floor(c.open_cents / 2) : c.open_cents;
        applications.push({ credit: pay.key, charge: c.key, amount_cents: amount, applied_on: runDate });
        c.open_cents -= amount;
        pay.total_cents += amount;
      });
      txns.push(pay);
    });

    if (profile.prepay) {
      txns.push({ key: `${profile.key}-prepay`, customer: profile.key, type: 'payment', txn_date: addDays(asOf, -9), due_date: null,
        memo: 'Prepayment for spring order', payment_method: 'Check', payment_ref: `Check ${check++}`, total_cents: 150000, open_cents: 150000, voided: false });
    }
  }

  // Doc numbers in date order, per type (QBO-style).
  txns.sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.key < b.key ? -1 : 1));
  const counters = { invoice: 0, sales_receipt: 0, credit_memo: 0 };
  const prefix = { invoice: 'INV', sales_receipt: 'SR', credit_memo: 'CM' };
  for (const t of txns) {
    t.doc_number = t.type in counters ? `${prefix[t.type]}-${String(++counters[t.type]).padStart(4, '0')}` : null;
  }

  // Weekly bank deposits: payments and sales receipts go to Operating Checking the Monday after they arrive,
  // except the last few days' worth, which are still sitting in Undeposited Funds.
  const byDate = new Map();
  for (const t of txns) {
    if ((t.type !== 'payment' && t.type !== 'sales_receipt') || t.voided || t.total_cents === 0) continue;
    const next = addDays(t.txn_date, 1);
    const monday = addDays(next, (8 - new Date(`${next}T00:00:00Z`).getUTCDay()) % 7);
    if (monday > addDays(asOf, -3)) continue;
    if (!byDate.has(monday)) byDate.set(monday, []);
    byDate.get(monday).push(t.key);
  }
  const spending = generateSpending(asOf, mulberry32(seed + 1000));
  const deposits = [...byDate.keys()].sort().map(d => ({ key: `deposit-${d}`, account: 'checking', txn_date: d, sources: byDate.get(d) }));

  const money = cents => `$${(cents / 100).toFixed(2)}`;
  for (const t of txns) {
    const cust = customers.find(c => c.key === t.customer);
    if (t.type === 'invoice') {
      const original = lines.filter(l => l.txn === t.key).reduce((s, l) => s + l.amount_cents, 0);
      activity.push({ customer: t.customer, txn: t.key, kind: 'invoice_created', summary: `Invoice ${t.doc_number} created for ${money(original)}`, occurred_at: at(t.txn_date, 15) });
      activity.push({ customer: t.customer, txn: t.key, kind: 'invoice_sent', summary: `Invoice ${t.doc_number} emailed to ${cust.email}`, occurred_at: at(t.txn_date, 16) });
      if (t.voided) activity.push({ customer: t.customer, txn: t.key, kind: 'txn_voided', summary: `Invoice ${t.doc_number} voided`, occurred_at: at(addDays(t.txn_date, 2), 17) });
    } else if (t.type === 'payment') {
      activity.push({ customer: t.customer, txn: t.key, kind: 'payment_received', summary: `Payment of ${money(t.total_cents)} received (${t.payment_ref})`, occurred_at: at(t.txn_date, 18) });
    } else if (t.type === 'sales_receipt') {
      activity.push({ customer: t.customer, txn: t.key, kind: 'sales_receipt_created', summary: `Sales receipt ${t.doc_number} for ${money(t.total_cents)}`, occurred_at: at(t.txn_date, 15) });
    } else if (t.type === 'credit_memo') {
      activity.push({ customer: t.customer, txn: t.key, kind: 'credit_memo_created', summary: `Credit memo ${t.doc_number} for ${money(t.total_cents)}: ${t.memo}`, occurred_at: at(t.txn_date, 15) });
    }
  }

  return {
    org: { slug: 'sample', name: 'Sample Org' },
    entity: { name: 'Sample Feed Co.', time_zone: 'America/Chicago', email: 'office@samplefeed.example', phone: '(940) 555-0100',
      address: { line1: '100 Mill Rd', city: 'Gainesville', state: 'TX', postal: '76240' } },
    terms: TERMS.map(({ key, name, due_days }) => ({ key, name, due_days })),
    items: ITEMS.map(({ key, name, kind, rate_cents, income }) => ({ key, name, kind, rate_cents, income })),
    accounts: ACCOUNTS.map(a => ({ ...a })),
    vendors: VENDORS.map(({ street, city, state, postal, ...v }) => ({ account_no: null, notes: null, ...v, billing_address: { line1: street, city, state, postal } })),
    customers, txns, lines, applications, activity, deposits, vendorDocs: spending.docs, billPayments: spending.payments,
    // Stocked items (tracked at average cost), an open purchase order and goods received but not billed yet.
    inventory: {
      items: [
        { key: 'salt', name: 'Salt Block (50 lb)', sku: 'SALT-50', rate_cents: 1195, cost_cents: 650, reorder: 40, start_qty: 120, as_of: addDays(asOf, -90), income: 'feed_sales' },
        { key: 'flyspray', name: 'Fly Spray (1 gal)', sku: 'FLY-1G', rate_cents: 3499, cost_cents: 1800, reorder: 12, start_qty: 40, as_of: addDays(asOf, -90), income: 'feed_sales' },
      ],
      purchaseOrder: { vendor: 'mill', txn_date: addDays(asOf, -6), expected: addDays(asOf, 5), lines: [{ item: 'salt', qty: '200', rate: '6.40' }] },
      itemReceipt: { vendor: 'mill', txn_date: addDays(asOf, -2), doc_number: 'LS-PL-8812', lines: [{ item: 'flyspray', qty: '24', rate: '18.50' }] },
    },
  };
}

// Expected open/overdue per customer straight from the generator (tests compare the DB to this).
export function expectedSummary(sample, customerKey, today) {
  let open = 0, overdue = 0;
  for (const t of sample.txns) {
    if (t.customer !== customerKey || t.voided) continue;
    if (t.type === 'invoice' || t.type === 'late_fee') {
      open += t.open_cents;
      if (t.due_date < today) overdue += t.open_cents;
    } else if (t.type === 'payment' || t.type === 'credit_memo') {
      open -= t.open_cents;
    }
  }
  return { openCents: open, overdueCents: overdue };
}
