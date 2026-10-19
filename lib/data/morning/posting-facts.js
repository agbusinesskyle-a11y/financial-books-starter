import { ValidationError } from '../writes.js';

// This relation lives only in the current snapshot. It retains zero-net accounts
// and changed transactions without money postings for the alert coverage rules.
// Entries and transfers select nonzero account nets from the same complete facts.
// Duplicate detail can omit types/party shapes that cannot be candidate vertices;
// this never filters the independent, organization-wide relationship edge graph.
const states = new WeakMap();
export const postingFactsState = tx => states.get(tx);
export function restorePostingFacts(tx, state) {
  if (state) states.set(tx, state); else states.delete(tx);
}
export async function ensurePostingFacts(tx, { orgId, today, window, budget = tx, includePeers, candidateOnly }) {
  const key = JSON.stringify([orgId, today, +new Date(window.from), +new Date(window.to)]);
  const prior = states.get(tx);
  if (prior) {
    if (prior.key !== key || includePeers !== undefined && prior.includePeers !== includePeers
      || candidateOnly !== undefined && prior.candidateOnly !== candidateOnly) throw new ValidationError('Invalid posting facts context');
    return;
  }
  includePeers ??= true; candidateOnly ??= false;
  // Apply the line-party existence predicate before the wider transaction join.
  // The complete source-ID array stays in PostgreSQL and gives the net read an
  // indexed lookup instead of hashing irrelevant posting history.
  await tx.query(`CREATE TEMP TABLE mv_posting_fact ON COMMIT DROP AS
    WITH party AS NOT MATERIALIZED (
      SELECT txn_id,count(DISTINCT customer_id)+count(DISTINCT vendor_id) party_count,
        least(min('c:'||customer_id),min('v:'||vendor_id)) line_party
      FROM posting WHERE org_id=$1 AND $5::boolean AND (customer_id IS NOT NULL OR vendor_id IS NOT NULL) GROUP BY txn_id
    ), source AS MATERIALIZED (
      SELECT t.txn_id,t.entity_id,t.type,t.txn_date,
        coalesce('c:'||t.customer_id,'v:'||t.vendor_id) header,coalesce(p.party_count,0) party_count,p.line_party,
        cs.entity_id IS NULL OR cs.home='USD' home_supported,
        ((t.created_at>$3::timestamptz AND t.created_at<=$4::timestamptz)
          OR (t.updated_at>$3::timestamptz AND t.updated_at<=$4::timestamptz)) seed,
        CASE WHEN t.created_at>$3::timestamptz AND t.created_at<=$4::timestamptz THEN 'added' ELSE 'historical_edit' END kind
      FROM txn t LEFT JOIN party p ON p.txn_id=t.txn_id
      LEFT JOIN currency_settings cs ON cs.org_id=t.org_id AND cs.entity_id=t.entity_id
      WHERE t.org_id=$1 AND t.voided_at IS NULL AND t.txn_date<=$2::date AND (
        (t.created_at>$3::timestamptz AND t.created_at<=$4::timestamptz)
        OR (t.updated_at>$3::timestamptz AND t.updated_at<=$4::timestamptz)
        OR ($5::boolean AND (t.customer_id IS NOT NULL OR t.vendor_id IS NOT NULL OR t.txn_id IN (SELECT txn_id FROM party))))
      AND (NOT $6::boolean OR (t.type IN ('expense','check','bill_payment','payment','sales_receipt','deposit','cc_credit','journal_entry')
        AND (coalesce(p.party_count,0)=0 AND (t.customer_id IS NOT NULL OR t.vendor_id IS NOT NULL)
          OR p.party_count=1 AND (coalesce('c:'||t.customer_id,'v:'||t.vendor_id) IS NULL
            OR coalesce('c:'||t.customer_id,'v:'||t.vendor_id)=p.line_party))))
    ), nets AS (
      SELECT p.txn_id,p.entity_id,p.account_id,a.type account_type,
        sum(p.amount_cents) m,min(p.txn_date) first_date,max(p.txn_date) last_date
      FROM posting p
      JOIN account a ON a.org_id=p.org_id AND a.entity_id=p.entity_id AND a.account_id=p.account_id
      WHERE p.org_id=$1 AND a.type IN ('bank','credit_card') AND p.txn_date<=$2::date AND p.txn_id=ANY(ARRAY(SELECT txn_id FROM source))
      GROUP BY p.txn_id,p.entity_id,p.account_id,a.type
    ) SELECT t.*,n.account_id,n.account_type,coalesce(n.m,0) m,n.first_date,n.last_date
    FROM source t LEFT JOIN nets n ON n.txn_id=t.txn_id AND n.entity_id=t.entity_id`, [orgId, today, window.from, window.to, includePeers, candidateOnly]);
  budget.check();
  states.set(tx, { key, includePeers, candidateOnly });
}
