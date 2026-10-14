// 1099-NEC totals. A payment counts when it went out of a bank account (check, ACH, cash) in the calendar year;
// card payments are left out because the card company reports those (1099-K).

export const THRESHOLD_CENTS = 60000;
const PAID = `t.type IN ('bill_payment', 'check', 'expense') AND t.voided_at IS NULL AND t.txn_date BETWEEN $3 AND $4`;

export async function list1099(db, { orgId, entityId, year }) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const { rows } = await db.query(
    `SELECT v.vendor_id, v.display_name, v.company_name, v.billing_address, v.tax_id_last4, v.track_1099, v.active,
            coalesce(sum(t.total_cents) FILTER (WHERE a.type = 'bank'), 0)::bigint AS paid_cents,
            coalesce(sum(t.total_cents) FILTER (WHERE a.type = 'credit_card'), 0)::bigint AS card_cents,
            count(t.txn_id) FILTER (WHERE a.type = 'bank')::int AS payments
       FROM vendor v
       LEFT JOIN txn t ON t.org_id = v.org_id AND t.vendor_id = v.vendor_id AND ${PAID}
       LEFT JOIN account a ON a.account_id = t.account_id
      WHERE v.org_id = $1 AND v.entity_id = $2
      GROUP BY v.vendor_id
      ORDER BY lower(v.display_name)`, [orgId, entityId, from, to]);
  const tracked = rows.filter(r => r.track_1099).map(r => ({ ...r, over: r.paid_cents >= THRESHOLD_CENTS, missingTaxId: !r.tax_id_last4 }));
  const untrackedOver = rows.filter(r => !r.track_1099 && r.paid_cents >= THRESHOLD_CENTS);
  return {
    year, tracked, untrackedOver,
    totals: { vendors: tracked.filter(r => r.over).length, paidCents: tracked.filter(r => r.over).reduce((s, r) => s + r.paid_cents, 0),
      missingTaxIds: tracked.filter(r => r.over && r.missingTaxId).length },
  };
}
