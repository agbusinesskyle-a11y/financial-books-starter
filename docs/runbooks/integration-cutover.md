# Integration cutover

This is an operator runbook, not evidence that rollout or deployment gates ran.
Builds/tests use disposable `fb_test_*` databases only. No real item setup has been
executed by the implementation build. Review the [API contract](../integration-v1.md)
before rehearsing. Preserve exact cents and approved name mappings throughout.

1. Disable client writers and Financial Books API writes. Keep QuickBooks as the
   official 2026 book. Freeze and retain final exports, reference comparison proof,
   the verified per-document QBO remittance/app-ledger cash baseline, and unresolved
   holds. Reconstructed imported cash allocations are not that baseline.
2. Build a **new** live copy from final evidence; never promote practice. Confirm
   financial/open-balance comparison, writes off and a new instance UUID. If using
   carry-over, review the preserved credentials and every reference-link leftover;
   revoke credentials that must not follow the copy. Retain the reference proof separately.
3. Save a disabled integration policy on the destination. Re-run the client map
   exporter using approved import name mappings. Resolve unknown accounts and
   review item/account/non-inventory parity. Preview item setup on this destination,
   approve its fresh canonical-content hash plus UUID/resolved account evidence,
   and apply exactly that hash. Retain preview/apply results privately.
4. Verify both current non-inventory mappings and historical inventory-era
   posting identity. Do not substitute accounts to force adoption. Review closed
   periods, source mappings and accounting acceptance evidence before enabling
   clients. Keep the integration date floor in force alongside any additional
   close-period guard required by your deployment.
5. Mint a narrowly scoped live token: `documents:write`, `bills:approve` if needed,
   and `settlements:read`. Bill categories must use supported noncash accounts;
   bank/card categories refuse for both signs, including unapproved bills.
   Omit `payments:write` for the January bank-first client;
   only a separately authorized cash-recording client needs it. Configure floor
   `2027-01-01` and label `live-2027`. Keep writes disabled until the checks below
   and release gates are satisfied.
6. Switch the client's URL, token, expected company, instance UUID/label and floor.
   Preflight all identity fields. When ready for the controlled rehearsal, enable
   API document writes. Link 2026 documents with `adopt_only:true`; confirm exact
   imported identity and no edits/duplicates, including paid Net-30 imports and
   aging-backed due dates. A missing or conflicting historic target remains held.
7. Skip imported application replay. Compare imported accounting totals/open
   balances and report reconstruction differences separately. Reconcile later
   native cash against the verified baseline. A genuine baseline mismatch, unknown
   linked identity or incomplete final page prevents all-clear. Sweep paid as well
   as unpaid documents through paginated reads; keep reconciliation cursor-free.
8. Keep QBO payment push off and settlement autorecord off until comparison is clean.
   Client legacy remittance forwarding requires durable successful QBO pull/CDC/
   matching evidence and a consistent frozen remittance version. Source edits after
   forwarding are drift/manual correction, not a new cash POST.
9. Rehearse a dropped response/retry, real imported adoption, bill approval, two
   partial settlements, removal of an application, known drift on an early page
   followed by a healthy later page, a failed final page, and the 1,000-document
   request/deadline budget. Retain source/target identity, counts and candidate SHAs.
10. After clean evidence, enable bank-review-first operation. Match existing cash;
    never Add it again. Use explicit grouped/fee matching and review uncertain
    pools. Enable settlement autorecord only after client baseline and identity
    gates pass. Portal payment-detail arrays still need the bounded companion
    follow-up; paid-status parity alone does not prove payment-detail UI parity.

Before rollout, run the full test suite and public-demo checks, review the exact
candidate revision, and verify deployed migrations and scheduled jobs against
your deployment procedure. Unexecuted checks are pending, never assumed green.
A build commit does not authorize a push or hosted rollout.

For rollback/holds, disable API writes and client writers/autorecord first. Preserve
links and frozen requests as evidence; revoke the affected credential if needed.
Do not recreate cash, replay imports or repair a drift by inventing a new source
reference. Resolve accounting changes through the reviewed ordinary workflow and
repeat reconciliation before re-enabling.
