# Migration map: private books → this starter

This starter was copied from the private Financial Books app at its migration 052. After that, the starter added two
migrations of its own for the public demo, so the two repositories number later migrations differently. The demo database
has already applied the starter's `053_demo_marker.sql` and `054_demo_marker_identity.sql` by those names, so they keep
their numbers, and every migration ported from the private app moves up by two.

A migration's file name is what `schema_migrations` records, so never rename a migration once a database has applied it.

| Private app | This starter | What it does |
| --- | --- | --- |
| 001 … 052 (same names) | 001 … 052 (same names) | Everything up to the copy |
| — | `053_demo_marker.sql` | Public demo: the demo mark |
| — | `054_demo_marker_identity.sql` | Public demo: the mark names its own database |
| `053_bank_review_v2.sql` | `055_bank_review_v2.sql` | Bank review v2, stage BR-1 |
| `054_bank_picker_snapshot.sql` | `056_bank_picker_snapshot.sql` | Bank review v2, stage BR-2 (pickers) |
| `055_bank_rules_v2.sql` | `057_bank_rules_v2.sql` | Bank review v2, stage BR-5 (rules v2) |
| `056_bank_item_files_notes.sql` | `058_bank_item_files_notes.sql` | Bank review v2, stage BR-7 (files and notes) |
| `057_bank_batch_selection.sql` | `059_bank_batch_selection.sql` | Bank review v2, stage BR-6 ("all N matching") |
| `058_bank_attachment_receipt.sql` | `060_bank_attachment_receipt.sql` | Bank review v3, stage S3 (texted receipts on the bank line) |
| `059_auto_vendor_research.sql` | `061_auto_vendor_research.sql` | Bank review v3, stage S5 (vendor research on its own) |
| `060_cc_credit.sql` | `062_cc_credit.sql` | Credit card credit |
| `061_loans.sql` | `063_loans.sql` | The Loans page |
| `062_tax_books_t1.sql` | `064_tax_books_t1.sql` | Tax Books T1 (contracts) |
| `063_tax_books_t2.sql` | `065_tax_books_t2.sql` | Tax Books T2 (bindings, coverage, suggestions, owners and members) |

Tests named for a migration follow the starter's number: the private app's `test/migration-053.test.js` is
`test/migration-055.test.js` here.

## Porting more later

1. A new private migration `0NN_name.sql` becomes `0(NN+2)_name.sql` here. Add a row above.
2. Change any reference to the file name or number to match: other migrations' comments, code comments ("migration 062"),
   and tests that read a migration file or filter on its number.
3. The starter holds no real data or names. Port only product code, tests, migrations and generic docs. Use made-up names
   in fixtures and comments, never a real company, person, account number or tax ID.
4. New pages and writes must keep the public demo's limits (`lib/domain/demo.js`): nothing that stores a secret, reaches
   outside (AI, texts, email, bank connections, payments), imports or uploads files, and batch actions take at most
   `DEMO_BATCH_MAX`. Command-line tools that write real books call `refuseDemoDatabase`. Add cases to
   `test/demo-hardening.test.js`.
