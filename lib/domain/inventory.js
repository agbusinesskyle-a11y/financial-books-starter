// Average-cost inventory. Quantities are BigInt scaled by 10^4 (like lines.js); money is whole cents.
//
// A move is one transaction line touching an inventory item, in date order:
//   'purchase'         bill / item receipt / check / expense line: in at what was paid (amountCents)
//   'vendor_return'    vendor credit / credit card credit line: out at the credit amount
//   'sale'             invoice / sales receipt line: out at the running average cost
//   'customer_return'  credit memo line: back in at the running average cost
//   'adjust'           quantity adjustment: delta signed; in/out at average cost, or at amountCents when given (opening stock)
// replay() returns each move's cost (the inventory value it moved, + in / − out) and the item's ending quantity and value.

const half = (num, den) => {
  // round(num / den) half away from zero, BigInt in, Number out.
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num, b = den < 0n ? -den : den;
  const r = (2n * a + b) / (2n * b);
  return Number(neg ? -r : r);
};

export const MOVE_KINDS = ['purchase', 'vendor_return', 'sale', 'customer_return', 'adjust'];

export function replay(moves) {
  let qty = 0n, value = 0n;
  // Last known unit cost (as a fraction value/qty), used while stock is zero or negative.
  let lastValue = 0n, lastQty = 0n;
  const costs = new Map();
  const unitCost = q => {
    if (qty > 0n) return half(q * value, qty);
    if (lastQty > 0n) return half(q * lastValue, lastQty);
    return 0;
  };
  for (const m of moves) {
    const q = BigInt(m.qty);
    let cost;
    switch (m.kind) {
      case 'purchase': cost = m.amountCents; break;
      case 'vendor_return': cost = -m.amountCents; break;
      case 'sale': cost = q === qty && qty > 0n ? -Number(value) : -unitCost(q); break;
      case 'customer_return': cost = unitCost(q); break;
      case 'adjust':
        if (m.amountCents !== undefined && m.amountCents !== null) cost = m.amountCents;
        else if (q < 0n) cost = -q === qty && qty > 0n ? -Number(value) : -unitCost(-q);
        else cost = unitCost(q);
        break;
      default: throw new Error(`unknown inventory move ${m.kind}`);
    }
    const signed = m.kind === 'sale' || m.kind === 'vendor_return' ? -q : q;
    qty += signed;
    value += BigInt(cost);
    // Nothing on hand is worth nothing: whatever value is left over goes with the move that emptied the shelf
    // (its cost differs from its amount; the difference posts to cost of goods sold).
    if (qty === 0n && value !== 0n) { cost -= Number(value); value = 0n; }
    if (qty > 0n) { lastValue = value; lastQty = qty; }
    costs.set(m.key, cost);
  }
  return { costs, qty, value: Number(value) };
}

// How each transaction type moves stock.
export const MOVE_FOR_TYPE = {
  bill: 'purchase', item_receipt: 'purchase', check: 'purchase', expense: 'purchase',
  vendor_credit: 'vendor_return', cc_credit: 'vendor_return', invoice: 'sale', sales_receipt: 'sale', credit_memo: 'customer_return', inventory_adjustment: 'adjust',
};
// On one day, stock coming in is counted before stock going out.
export const MOVE_ORDER = { purchase: 0, customer_return: 1, adjust: 2, vendor_return: 3, sale: 4 };
