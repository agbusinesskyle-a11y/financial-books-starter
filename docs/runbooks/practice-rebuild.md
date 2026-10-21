# Rebuild a hosted copy from a reference import

This runbook is for self-hosted copies. All five rebuild CLIs refuse `DEMO_MODE=1` and marked public demo
databases; copy checks both endpoints, and rehearsal also checks the restored database. Carry-over commands,
including `report`, require `DATABASE_URL`. The starter's demo marker table is kept during a rebuild.

The export/session helpers, URL files, company maps and tax setup scripts mentioned below are operator-provided
examples outside this repository, not tools shipped with the starter. Supply and verify your own equivalents.
The dates describe an example practice schedule; choose your own cutover dates and obtain your own approvals.

Use this for a deliberate re-baseline of the practice copy. The year-end live prerequisites below must be completed
in a separate live procedure before using these mechanics at the freeze.
Never promote a practice copy; always build from a fresh full-history export.

Replace `<imports>` with the private operations folder and `<date>` with the export's as-of date. Keep exports,
URL files, carry-over files, dumps and receipts outside the repository. Run product scripts from the repository
root. The export and session commands require the outside-repository tools from true-up plan Tasks 10–12.
Keep `BOOKS_MODE=practice` throughout a practice rebuild. Preserve `SETTINGS_KEY`, `APP_ORG`,
`APP_OWNER_USER_ID` and the ledgerline configuration; saved ciphertext requires the same `SETTINGS_KEY`.
Set `DATABASE_URL` from the indicated URL file without printing it. Pass `--org <org slug>` to carry-over
commands, or set `APP_ORG`; there is no built-in org default. Use the linked deploy directory for Railway commands.

1. Export every company from QuickBooks: `bash "<imports>\tools\trueup-export.sh" <date>` with the dedicated
   Chrome window signed in. Check `<imports>\exports\<date>\manifest.json` lists each company's
   `Journal.xlsx`, `Trial_balance.xlsx` and `Account_list.csv`, plus the aging and any required inventory reports.
   For a company captured in chunks, check `journal/manifest.json` and every expected half-year part.
2. Build the reference: `bash "<imports>\tools\ref-import.sh" <date>`. Every company must print
   "every account matches QuickBooks to the penny" or carry a documented accepted difference. The import script does
   not create the URL file: create `<imports>\local-fbref-<date>.url` from the intended reference connection privately.
   Before using it, verify `current_database()`, server address/port, org slug, the complete expected company list,
   exactly one consistent import batch for every company and the export date/manifest. Do not infer identity from the file name. Run
   `node scripts/rebuild-check.mjs "<imports>\local-fbref-<date>.url" <date> --companies "<imports>\changeover\state\companies-map.json" --exports "<imports>\exports\<date>"` and require exit 0.
   Confirm source and target migration name sets match and org ids refer to the same org slug.
3. Take the site down from the linked deploy directory: `railway down --service books -y`.
   Freeze all writes, including schedulers, workers and manual writers. Keep this write freeze across
   **save → dump → clear**, and through copy and links; practice mode still permits bank pulls.
   Save the copy's practice-only state with `DATABASE_URL` set to its app URL file content:
   `node --env-file=.env scripts/carry-over.mjs save "<imports>\changeover\carry\<date>.json" --org <org slug>`.
   Review the printed `decisions`, `leftovers` and `unclassified` sections with the owner. Stop if a leftover
   matters or a table is unclassified. If any write occurs, restart from save and take a new dump and rehearsal.
4. Dump with the PostgreSQL 18 client in a shell that supports command substitution:
   `C:/tools/pgsql18/bin/pg_dump.exe -Fc -d "$(cat '<imports>/books-db-su-public.url')" -f "<imports>/backups/practice-before-rebuild-<date>.dump"`.
   The dump's mtime must be later than both the carry-over file's mtime and its savedAt. Run
   `node scripts/dump-rehearse.mjs <dump file> <local admin url file>` against a local `postgres` maintenance database.
   It fully decodes the archive, restores into a fresh randomly named throwaway database, counts every table,
   drops that database, and writes `<dump file>.receipt.json` with SHA-256, size, archive database, counts and time.
   The local restore uses the admin owner and omits source ACLs; source roles are not required locally.
   PostgreSQL 18 clients restoring to an older local server omit only the unsupported `transaction_timeout` session
   setting; the SQL restore still stops on every error. Keep the dump and receipt together.
   Clear independently decodes the data payload, verifies archive identity/time/table coverage and requires the
   receipt's SHA-256/size to match the exact current dump bytes and all table counts to match the target snapshot.
   `PG_RESTORE` (and `PSQL` for older local servers) can override the installed client paths.
5. Confirm the site is still down and the write freeze has held since save. Clear re-runs the saver in its
   locked target transaction, normalizes unordered collections by natural identity and drops volatile metadata,
   then requires deep content equality. Duplicate identities or any differing path refuse; ciphertext must match
   byte for byte. Dump/rehearsal counts remain additional checks and do not establish content equality.
   Classes and class references use the full parent path, so the same child name under different parents
   remains distinct during validation and restore. Locations are flat and use their company-scoped name.
6. Clear with `DATABASE_URL` set to the admin URL file content:
   `node scripts/clear-books.mjs --carry-over <carry file> --dump <dump file> --rehearsed <dump file>.receipt.json --apply`.
   Without `--apply`, the command prints table counts and changes nothing. It keeps org, migrations, users,
   invites and all audit history; account and transaction ids in old history can become stale.
7. Copy: `node scripts/copy-books.mjs "<imports>\local-fbref-<date>.url" "<imports>\books-db-su-public.url" --companies "<imports>\changeover\state\companies-map.json" --exports "<imports>\exports\<date>" --apply`.
   Require "copied and verified". The target URL must be an admin connection. The source company set must exactly match the map; each batch summary must match the current imported count and latest date. Source practice-only state,
   target books, schema differences or failed integrity checks stop the copy. Both copy and rebuild-check require
   the dated `--exports` folder and the same `--companies` map. Each `{fbName, slug}` entry locates
   `<exports>/<slug>/export/Trial_balance.xlsx`; legacy name arrays use a lowercase, hyphen-separated name as slug.
   Every account balance must match to the cent. An exception must be recorded in that company's
   `import_batch.summary.acceptedMismatches` as `name: QuickBooks X, here Y`. Parse X and Y in exact cents:
   the retained export must still equal X and the current difference must equal exactly Y minus X.
   The importer's explicit absent-account format means X is zero. Reject malformed/ambiguous approvals and
   every other drift; account names or `acceptedNames` alone never waive differences.
   Copy checks both source and target before commit. Transaction totals must equal debit postings, and lines must
   produce the stored postings per account and date; each posting date must equal its transaction date.
   Read the retained Journal.xlsx (or manifested half-year parts) through qbo-read. Its transaction count after
   zero-amount omissions must equal the imported primary count; COGS companions are additional transactions
   whose postings remain in the Journal comparison. Compare every month/account debit and credit sum separately,
   using signed Journal lines as the importer does, across native type remaps and journal fallbacks. These checks are read-only and refuse damage without repairing it.
   Fresh imports retain shapes whose document total differs from gross debits (such as cash-back deposits) as
   journal entries with their original posting amounts. Existing imports that fail this rule require a fresh import.
8. Restore links with `DATABASE_URL` set back to the copy's app URL file content:
   `node scripts/carry-over.mjs apply <carry file> --org <org slug> --phase links --apply`.
   Require every intended company link and a configured target tenant matching the saved tenant. New links have
   no last-pull time so the scheduler pulls promptly; reruns preserve existing pull times.
9. Bring the site up: `railway up --service books --detach`. Wait for `/healthz` and confirm the first pull
   creates feed accounts for each linked company. A normal startup begins pulling within a minute; inspect logs if delayed.
10. Restore feeds: `node scripts/carry-over.mjs apply <carry file> --org <org slug> --phase feeds --apply`.
    This waits up to 20 minutes for pulled accounts, then applies mappings, rules and holds. Use `--wait-minutes N`
    to set a different bound. Then run
    `node scripts/carry-over.mjs apply <carry file> --org <org slug> --phase books --apply`.
    Rules restore as one ordered set for the entire feeds pass. Every rule's accounts, splits, payee, classes,
    locations and feed accounts must resolve first. If any rule cannot resolve, no rules are restored; each
    unresolved rule reports its reason and the remaining rules report that the set is deferred. Review every skip
    and decision, restore missing dependencies in books or wait for the required feed accounts, then rerun feeds.
    A successful pass verifies the saved order against database priority/rule_id order; repeat passes preserve it.
    An existing partial set that would change precedence refuses with a decision. Stop and reconcile that set
    against the protected carry file before retrying; do not enable incomplete automation or treat a retry alone
    as resolution. Refresh bank feeds after mappings so transaction items arrive.
    Closed accounts use the owner's current exclusion list. Renames and native transactions remain decisions;
    carry-over does not automatically recreate them. Native applications also remain decisions: re-apply them by hand after the rebuild, checking both transaction identities, amount and applied date against existing settlements to avoid duplication. Each decision shows the decrease to the credit unapplied amount and charge open amount; verify both final open amounts against the saved values. Omitting `--apply` produces a read-only plan in `planned`, without consuming sequence values. Writer validation happens during the actual apply; review its skips and leftovers.
11. Re-run the tax setup scripts in `<imports>\tax-books`: profiles, parties, periods, owners, baselines and
    EIN reconciliation. Confirm company identities before scripts that use fixed entity ids.
12. Prove the copy: `node scripts/rebuild-check.mjs "<imports>\books-db-app-public.url" <date> --companies "<imports>\changeover\state\companies-map.json" --exports "<imports>\exports\<date>"` must exit 0.
    Confirm the database comment is still `financial-books practice copy`, the login page shows the practice banner,
    and the owner can sign in. Re-enrol Morning View and verify saved settings through the app. Review bank items
    again and resolve any approved native-entry decisions with the owner. Run
    `node "<imports>\session\session-all.mjs" <date> --books practice --full`; retain the receipts and accepted differences.
13. Roll back only before step 10 is complete: keep the site down, run
    `C:/tools/pgsql18/bin/pg_restore.exe --clean --if-exists --single-transaction --exit-on-error -d "$(cat '<imports>/books-db-su-public.url')" <dump file>`,
    then `railway up --service books --detach`. Preserve dumped ownership; do not pass `--no-owner`.
    Recheck health, the practice marker and sign-in. After step 10, reconcile intervening work before choosing a recovery path.

Before a year-end live procedure is ready, record a dedicated live database/server identity, app URL and service,
private app/admin connection files, complete expected companies and freeze/export manifest. Configure `BOOKS_MODE=live`,
the intended `APP_ORG`, owner identity, the same `SETTINGS_KEY` as the saved ciphertext and the matching ledgerline tenant.
Verify the live database marker and endpoint, sign-in and live behavior, and run rebuild-check against that explicit live
connection. The installed session runner accepts only `--books practice|local` and defaults to practice; it cannot prove
a distinct live target. Add and test an explicit live target with receipts identifying the live endpoint before the
December build. A practice banner or a receipt from the practice endpoint is not live acceptance evidence. Keep live
startup, write enablement and recovery steps in that separate procedure; this practice checklist does not authorize them.

The transient classification is a deliberate discard policy. Picker/upload state can be rebuilt, but original activity, AI calls, pull history, Morning observations/visits and tax revision history do not regenerate. Review the save report's `discarded` counts and retain the dump. Manual or decided vendor research is also flagged in `leftovers`; export or resolve it before clear.

Reruns preserve tested business values and deduplicate research attempts; they can advance rule timestamps, mapping timestamps and other writer metadata. A successful wait means at least one feed account exists per linked company. Check every saved UUID mapping result and resolve every skip; that readiness check does not prove all accounts have arrived.

## Residual risk — 2026-10-20

The source review recorded round 5 Blocking 2 (V2) as residual risk outside this runbook. Each self-hosted
operator must decide whether to accept that risk. The reference must come
untouched from `ref-import.sh`; do not alter its locked imported history through privileged maintenance edits.
The copy and rebuild-check gates do not prove per-document date fidelity against the retained Journal.
For example, moving a transaction header and its postings together to another day in the same month can
preserve counts, monthly account totals and header/posting agreement while changing a historical daily balance,
and both gates can still pass. V2 requires an out-of-runbook reference edit; it does not demonstrate that the
normal rebuild corrupts a pristine reference. These gates do not fix this risk.
