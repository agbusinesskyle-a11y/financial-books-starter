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
3. Run `node "<imports>\session\session-all.mjs" <date>` against the practice copy. The runner processes
   companies sequentially; require every company in its summary and investigate any failure or diagnostic result.
   Use the session skill for account scope, capture freshness, date windows and individual company commands.
4. Read each session receipt. Compare practice with the export, compare the new reference with the previous one
   using the reference-diff workflow when installed, and inspect account, customer and vendor list changes.
   Track added, changed or vanished history and voids. Keep the company-name map and importer account-name map
   with the evidence; do not assume database ids identify transactions across references.
5. Classify every difference as `timing`, `approved_historical`, `quickbooks_error`, `books_defect`,
   `missing_evidence` or `unexplained`. Have the owner approve timing and historical differences. Create a tracked
   issue for a books defect and attach its receipt. Recheck timing differences every session until they clear.
6. Fix the books with the owner, then recompare using the skill's commands. The owner makes any QuickBooks
   corrections; the next export captures them. Mirror approved work with its QuickBooks number and an actor
   label such as `the owner - mirrors QuickBooks <ref>`. Imported history stays locked: record an approved dated
   correcting entry for a changed historical transaction and retain the matching reference-diff evidence.
7. Mark findings with the evidence and owner decision, then close each session using the skill. Confirm the
   account checkpoint advanced only for covered work. Archive receipts, findings and unresolved issues with the export.
8. At month-end, run `node "<imports>\session\session-all.mjs" <date> --full`. Require live full-history
   coverage, zero unexplained differences and owner sign-off for every company; a diagnostic run cannot satisfy this gate.
9. If drift warrants a deliberate re-baseline, archive the trial evidence and follow
   [the rebuild runbook](practice-rebuild.md). Avoid routine refreshes that erase practice work. The year-end
   freeze requires a separately documented and tested live-target procedure with a fresh final full-history export.
   The installed session runner accepts only `practice|local` and defaults to practice; explicit live endpoint support
   and endpoint-bound receipts must be added and tested before December. Never promote the practice copy.
