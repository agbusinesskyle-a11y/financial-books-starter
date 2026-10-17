// lib/tax/authority.js
// Routing versus authority (spec §4.7 rule 0.4, Codex t2-plan-r1 B1). A binding ROUTES a book measurement to a slot; it never decides
// whose result is the slot's tax amount. Exactly one provider is authoritative per slot (or collection member):
//   - the T1 assignment (tax_provider_assignment, unique per slot) when there is one — set or changed only through T1's assignProvider /
//     substituteProvider, atomic and audited; a binding keeps its routing across such a change;
//   - otherwise the default: a Form 1125-A / Schedule C or F COGS line → the COGS workpaper; a typed (manual) line → the manual provider;
//     an income or expense line of a cash-method return → the cash layer; everything else → the books.
// A binding's role follows from its treatment and the slot's authority, so no provider's output is ever added to another's:
//   authoritative  the books measurement IS the tax amount (books authority, and no contribution to the slot needs cash conversion);
//   input          the slot's one owner consumes it (cash layer: every routing to a slot it owns — also the accrual contributions of a slot
//                  a cash-basis source feeds (Codex r2 B1); COGS workpaper: purchases, labor, other costs);
//   comparison     shown beside another provider's result, never the tax amount (manual_feed, cogs_tieout, and any routing to a slot a
//                  manual, asset-register or K-1 provider owns).
import { isCogsLine } from './destinations.js';

export function defaultAuthority(line, { taxMethod }) {
  if (isCogsLine(line.id)) return 'cogs_workpaper';
  if (line.kind === 'manual') return 'manual';
  if (taxMethod === 'cash' && line.cls !== 'balance') return 'cash_layer';
  return 'books';
}
// Whether one contribution needs the cash layer to become a tax amount: cash-basis books (any measurement), or an income or expense line of
// a cash-method return.
export const needsCash = (line, { taxMethod, sourceBookBasis }) => sourceBookBasis === 'cash' || (taxMethod === 'cash' && line.cls !== 'balance');
// The ONE owner of a slot (Codex r2 B1). assignment: T1's provider_kind for the slot, or null. anyCash: some contribution to the slot needs
// cash conversion. Without an assignment a books slot with such a contribution belongs to the cash layer as a whole (every contribution is
// its input); with an assignment to the books it is a mismatch (problem), never a books subtotal beside a cash-layer input.
export function slotAuthority(line, { taxMethod, assignment = null, anyCash = false }) {
  if (assignment) {
    return { authority: assignment, problem: assignment === 'books' && anyCash ? 'The books are assigned this line, but cash-basis books or cash-method amounts feed it: assign it to the cash layer.' : null };
  }
  const d = defaultAuthority(line, { taxMethod });
  return { authority: d === 'books' && anyCash ? 'cash_layer' : d, problem: null };
}
// assignments: Map slotKey → provider_kind (T1 rows of the return).
export function authorityOf(slotKey, line, { taxMethod, assignments }) {
  return assignments.get(slotKey) ?? defaultAuthority(line, { taxMethod });
}
// The role of one routed allocation, given its slot's one owner.
export function roleOf({ treatment, authority }) {
  if (treatment === 'manual_feed' || treatment === 'cogs_tieout') return { role: 'comparison', provider: authority };
  if (treatment === 'cogs_input') return authority === 'cogs_workpaper' ? { role: 'input', provider: 'cogs_workpaper' } : { role: 'comparison', provider: authority };
  if (treatment === 'input' || treatment === 'statement_row') {
    if (authority === 'books') return { role: 'authoritative', provider: 'books' };
    if (authority === 'cash_layer') return { role: 'input', provider: 'cash_layer' };
    return { role: 'comparison', provider: authority };
  }
  return { role: null, provider: null };
}
