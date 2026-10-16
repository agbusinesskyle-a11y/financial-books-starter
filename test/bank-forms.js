// What a bank item page shows, read back the way a browser posts it (bank review v2: every form carries what it showed).
const unescape = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const hidden = (page, name) => {
  const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(page);
  return m ? unescape(m[1]) : null;
};
export async function itemForm(app, id) {
  const page = await (await app.get(`/banking/item/${id}`)).text();
  return { page, rev: hidden(page, 'rev'), plan: hidden(page, 'plan'), evidence: hidden(page, 'evidence'), ver: txnId => hidden(page, `ver_${txnId}`) };
}
// The list page's hidden fields for ticked items (rev_<id>, intent_<id>).
export async function listFields(app, account, ids) {
  const page = await (await app.get(`/banking?account=${account}&tab=review`)).text();
  const out = [];
  for (const id of ids) {
    for (const k of [`rev_${id}`, `intent_${id}`]) {
      const v = hidden(page, k);
      if (v !== null) out.push([k, v]);
    }
  }
  return out;
}
// The picker snapshots an item page's forms carry (cats_v, payees_v), for a post built by hand.
export async function picks(app, id) {
  const page = await (await app.get(`/banking/item/${id}`)).text();
  return [['cats_v', hidden(page, 'cats_v') ?? ''], ['payees_v', hidden(page, 'payees_v') ?? '']];
}
