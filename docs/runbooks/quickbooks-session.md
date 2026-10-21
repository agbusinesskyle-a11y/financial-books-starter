# Weekly QuickBooks session

This runbook is for self-hosted copies. The external skill, export/session helpers and private operations files
referenced below are operator-provided examples and are not included in this starter. Supply and verify your own
equivalents, schedule and cutover dates. The rebuild CLIs refuse public demo mode and marked demo databases.

Run weekly and on the last business day of each month while working both systems in parallel. QuickBooks remains
the official books through December 31, 2026; automation only reads it. Keep the practice copy in practice mode.
Use the installed `~/.claude/skills/quickbooks-session/SKILL.md` for current `start`, receipt, `recompare`, `mark`
and `close` commands. These steps require the outside-repository session upgrades from true-up plan Tasks 10–12.
`<imports>` is the private operations folder; keep all evidence there.

1. Open QuickBooks in the dedicated signed-in Chrome window. Export all companies with
   `bash "<imports>\tools\trueup-export.sh" <date>`. Check each company identity, full-history coverage,
   required reports and manifest hashes. Preserve previous exports. A chunked company needs its journal manifest
   and every required part; confirm the capture qualifies as live rather than diagnostic.
2. Build a fresh reference with `bash "<imports>\tools\ref-import.sh" <date>`. Require importer parity or a
   documented accepted difference, then exit 0 from
   `node scripts/rebuild-check.mjs "<imports>\local-fbref-<date>.url" <date> --companies "<imports>\changeover\state\companies-map.json" --exports "<imports>\exports\<date>"`.
3. Compare the frozen references from the repository root, using a new private output directory:
   `node scripts/ref-diff.mjs C:/sample-imports/local-fbref-2026-10-20.url C:/sample-imports/local-fbref-2026-10-27.url --out C:/sample-imports/refdiff/2026-10-27`.
   Substitute the actual before/after dates and keep both references, original exports and manifests intact.
   Exit 0 means a valid comparison, including differences; exit 1 is a refusal/I/O failure and exit 2 is usage.
   Read `diff.json`, `report.md` and `rename-map.candidate.json`. Review each company's primary-document counts,
   separately identified omissions/voids, ambiguous rows, chart/list changes and open-item allocations.
   This evidence never authorizes incremental import or editing locked history.
   New imports must contain version 1 `referenceIdentity` evidence for original numbers and party inference.
   Pin the importer checkout/revision actually used by the external runner; a product worktree alone does not
   redirect that runner. Legacy references without evidence refuse: preserve them and build separately named
   references from the retained exports using the reviewed importer. Never backfill evidence into old references.
   Account identity retains original parent paths, base names, account numbers and types. Deleted/live twins
   remain distinct; an unambiguous reactivation is a status change. Indistinguishable tuples or ambiguous parent
   evidence refuse with the collision kind. Number/type changes may appear as added and vanished accounts.
   Use `--counts-only` when account and party names must stay out of artifacts. This retains per-company counts,
   omits detailed evidence and marks the empty candidate file with `detailsOmitted: true`; it cannot support candidate review.
4. Run `node "<imports>\session\session-all.mjs" <date>` against the practice copy. The runner processes
   companies sequentially; require every company in its summary and investigate any failure or diagnostic result.
   Use the session skill for account scope, capture freshness, date windows and individual company commands.
5. Read each session receipt. Compare practice with the export and review the reference comparison from step 3,
   including account, customer and vendor list changes.
   Track added, changed or vanished history and voids. Keep the company-name map and importer account-name map
   with the evidence; do not assume database ids identify transactions across references.
   Rename candidates remain unapproved and keep their additions/disappearances visible. Update the maintained
   private name map only after owner review of each candidate, retaining both source hashes and the decision.
   Candidate approval does not suppress differences already detected in this run.
6. Classify every difference as `timing`, `approved_historical`, `quickbooks_error`, `books_defect`,
   `missing_evidence` or `unexplained`. Have the owner approve timing and historical differences. Create a tracked
   issue for a books defect and attach its receipt. Recheck timing differences every session until they clear.
7. Fix the books with the owner, then recompare using the skill's commands. The owner makes any QuickBooks
   corrections; the next export captures them. Mirror approved work with its QuickBooks number and an actor
   label such as `the owner - mirrors QuickBooks <ref>`. Imported history stays locked: record an approved dated
   correcting entry for a changed historical transaction and retain the matching reference-diff evidence.
8. Mark findings with the evidence and owner decision, then close each session using the skill. Confirm the
   account checkpoint advanced only for covered work. Archive receipts, findings and unresolved issues with the export.
9. At month-end, run `node "<imports>\session\session-all.mjs" <date> --full`. Require live full-history
   coverage, zero unexplained differences and owner sign-off for every company; a diagnostic run cannot satisfy this gate.
10. If drift warrants a deliberate re-baseline, archive the trial evidence and follow
   [the rebuild runbook](practice-rebuild.md). Avoid routine refreshes that erase practice work. The year-end
   freeze requires a separately documented and tested live-target procedure with a fresh final full-history export.
   The installed session runner accepts only `practice|local` and defaults to practice; explicit live endpoint support
   and endpoint-bound receipts must be added and tested before December. Never promote the practice copy.

A changed transaction is a mutually unique one-field content candidate, not proven persistent identity.
Repeat indexes count multiplicity: `[X,X]` becoming `[X,Y]` can remain added/vanished. Multiple-field edits and
ambiguous matches also remain additions/disappearances. Memo-only/contact-only edits are outside the transaction
fingerprint. Zero alone is only a possible void. Open allocations describe terminal imported settlement at
9999-12-31; original payment links are reconstructed oldest-first, so a reapplication leaving aging unchanged
is not observable. Inferred party namespaces are a recorded importer policy, not proof of export-list membership.

Require independent accounting-correctness review before operational C4 use. Preserve the accepted R5 V2
residual risk in [the rebuild runbook](practice-rebuild.md): this comparison detects differences between its inputs,
and does not certify either reference's fidelity to the retained Journal or detect every privileged history edit.
The tool never writes either database or QuickBooks.

Focused verification from the repository root:
`node --test --test-concurrency=1 test/refdiff-accounts.test.js test/refdiff-fingerprint.test.js test/refdiff-snapshot.test.js test/refdiff-compare.test.js test/refdiff-cli.test.js test/refdiff-report.test.js`.
Require zero failures. Include `test/refdiff-import.test.js` and `test/import-qbo.test.js` when verifying
the importer changes. Integration fixtures create and drop disposable test databases. Keep URL files, reports and real data outside Git.
