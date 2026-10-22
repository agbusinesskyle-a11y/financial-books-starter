# Integration API v1

All routes are under `/api/integration/v1`. Use HTTPS outside local tests and an
`Authorization: Bearer fbi_v1.<id>.<secret>` header. Tokens have 256 random secret
bits; only a SHA-256 digest is stored. Admins mint/revoke them under Settings →
Integrations. Copy the secret from the mint response once; it cannot be retrieved.
Requests never fall back to browser cookies. Browser Settings retains its normal
session, company-access and CSRF checks. No CORS access is enabled. The API and
integration settings are disabled in the public demo; item setup also refuses
demo mode and databases carrying the demo marker.

A token binds one organization, company and stable source namespace. Reuse the
namespace when rotating credentials: identity is `(company, source, source_ref)`,
not the token ID. Request bodies cannot select a company or source. Revocation
and write-policy/scope revalidation occur under the company lock before writing.
All companies default to writes off. Enabling requires an explicit write floor
and configured instance label. Rebuilds carry token hashes with their original
credential IDs and reconnect external references by natural transaction identity.
Conflicts remain explicit leftovers. Restored policy disables writes and retains
the destination UUID rather than the source UUID. See the
[rebuild runbook](runbooks/practice-rebuild.md) before enabling clients again.

## Routes and transport

| Method/path | Scope | Result |
| --- | --- | --- |
| GET `/companies` | Any valid token | `{companies:[{entity_id,name,instance_id,ledger_instance,write_floor,accept_writes}]}` |
| POST `/invoices` | `documents:write` | Create or link invoice |
| POST `/bills` | `documents:write`, plus `bills:approve` for `approve:true` | Create/link and approval atomically |
| POST `/customer-payments` | `payments:write` | One customer cash receipt with explicit applications |
| POST `/bill-payments` | `payments:write` | One vendor cash payment with explicit applications |
| GET `/settlements?after_ref_id=0&limit=100` | `settlements:read` | Complete document snapshots, paged by reference ID |
| GET `/documents/<encoded-source-ref>/settlement` | `settlements:read` | One complete linked invoice/bill snapshot |

POST uses `application/json` (optional `charset=utf-8`), at most 128 KiB. Unknown
fields refuse. IDs are strings; cents are safe JSON integers. Dates are calendar
`YYYY-MM-DD`, without timezone conversion. Names resolve exactly, active and in
the bound company. There is no automatic party/account/item creation. Responses
are JSON with `Cache-Control: no-store`; unexpected errors are sanitized. The
shared database limit is 120 authenticated requests per token per minute; failed
authentication has a bounded per-process IP limiter: at most 30 failed or pending
credential checks per IP per minute. Admission reserves a slot before any database
lookup, including concurrent attempts; a valid secret releases that slot and uses
the shared token budget. An exhausted IP receives 429 without database work, even
if its next credential is valid, until the next minute. On 429 honor `Retry-After`.

Success is `{status,txn_id,source_ref,doc_number,total_cents,open_cents,instance_id,
ledger_instance}`. `created` returns 201; `adopted` and `existing` return 200.
Repeat the exact frozen payload after a lost response. The canonical request
hash ignores object-key order, preserving array order and all values. A changed
payload at the same reference conflicts; manual remote drift also conflicts.
Creation, approval, applications and reference insertion share one transaction.
No update, delete or void endpoints exist in v1.

## Documents

Invoice body: `{source_ref,doc_number,customer_name,txn_date,due_date,terms_name?,
memo?,total_cents,lines,adopt_only?}`. Bills use `vendor_name` and may add `approve`.
`source_ref` is at most 200 characters, document number 30, party 200, terms 60,
memo 1000. Text is exact, trimmed, without control characters. Dates are required;
due date cannot precede transaction date. Total must be positive. There are
1–500 lines. An item line is `{item_name,description?,quantity,rate_cents,
amount_cents}`: non-inventory item, positive quantity as a decimal string with up
to four fractional digits, signed integer rate, exact rounded line amount. A bill
category line instead has `{account_name,description?,amount_cents}`. Description
is at most 500 characters, item name 100, account name 200. Zero line amounts,
tax, foreign currency, inventory and unsupported category accounts refuse.
Bill categories support active noncash `other_current_asset`, `fixed_asset`,
`other_asset`, `other_current_liability`, `long_term_liability`, `equity`, `income`,
`other_income`, `cost_of_goods_sold`, `expense` and `other_expense` accounts.
Bank, credit-card, A/R, A/P, inventory and system Undeposited Funds categories
refuse for either sign, including unapproved bills and adoption requests. Cash
recording requires the payment endpoints and `payments:write`.
Signed amounts must sum exactly to the header total. New invoices require custom
invoice numbers enabled. HTTP cannot change item mappings or inventory behavior.

An unlinked existing document may be adopted only when type, number, party,
date, currency, total and gross positive/negative account postings agree. Bill
numbers also resolve within vendor; ambiguous candidates refuse. Voided targets
refuse. Imported account-based lines/provenance remain untouched, including any
companion inventory postings. Approval requested for an existing bill must
already agree. A historical inventory account mismatch stays on hold for review.

Imported paid documents may have an importer-derived due date equal to their
transaction date because the export lacked terms. That fallback does not require
strict due-date equality. A distinct imported due date, including one recovered
from open aging, must agree. This exception changes no stored financial row.

Set `adopt_only:true` for historical requests. A missing target returns 409
`adoption_required` even if server policy has a lower floor than the client.
Clients must preflight company, UUID, label and floor against cutover settings;
the locked server precondition still governs if policy changes after preflight.
New accounting documents below the floor always refuse. Historical exact links
are allowed while writes are enabled. Payments have no historical adoption mode.

## Recorded payments

Body: `{source_ref,customer_name|vendor_name,txn_date,amount_cents,method,reference,
memo?,deposit_to_account_name|bank_account_name,applications,check_no?}`. Customer
deposit account must explicitly be `null` for Undeposited Funds or an active bank
name. Vendor account must be an active bank/credit-card account. `reference` is
required (empty permitted), at most 50 characters, retained as `payment_ref`.
Customer method is text up to 50 characters. Bill method is one of `Check`, `ACH`,
`Credit card`, `Debit card`, `Cash`, `Other`. Check requires 1–9 digits in `check_no`,
preserving leading zeros; other methods reject it. ACH requires a verified vendor.

Each application is `{source_ref|doc_number,amount_cents,applied_on?}`; exactly one
reference choice, positive cents, same party/type/company, nonvoid domestic open
document and no repeated target. Bills must be approved. Applied date defaults
to payment date and cannot precede either document. Bill applied date must equal
payment date. Customer applications may be later. At most 500 applications;
customer sum may be less than the payment (including empty/on-account), bill sum
must equal it and cannot be empty. No automatic application occurs, even when
ordinary company settings enable it. Any invalid member rolls back the entire
remittance. Historical payments never adopt by number/free text. Current identical
retries verify cash header, account and full application vector before succeeding.

## Settlement evidence and full reconciliation

Page: `{documents,next_after_ref_id,complete,instance_id,ledger_instance}`. Limit
is 1–100. Each document contains `{ref_id,source_ref,txn_id,doc_number,type,txn_date,
party_name,total_cents,open_cents,voided_at,complete:true,applications}`. Application:
`{application_id,credit_txn_id,type,amount_cents,applied_on,payment_method,payment_ref,
account_name,voided_at,source,allocation_evidence,cash_history_authoritative}`.
Application identity is the opaque `instanceUUID:applicationID`; clients can use
`fb-app:<application_id>` as their idempotency key. Credit memo/vendor credit types
remain noncash. Do not infer payment type or amount from a balance change.

Imported `source:'qbo_import'` applications explicitly carry
`allocation_evidence:'reconstructed'` and `cash_history_authoritative:false`.
They reconstruct accounting balances oldest-first, not original per-document cash
allocations. Never insert/reverse client cash from those links. Retain a separately
verified per-document source-remittance/app-ledger cash baseline and reconcile
subsequent native applications against it. Report reconstruction differences
separately; an actual baseline mismatch blocks cutover. Native applications use
`allocation_evidence:'native'`; cash use additionally requires an actual cash type.

Reset cursor to `0` after every full sweep and include fully paid documents. Each
page is one repeatable-read read-only transaction, not one snapshot across an
entire multi-page sweep. Every returned document includes all its applications.
A missing application implies removal only inside a successful complete document
snapshot. An HTTP error, 404, missing page or unobserved document never implies a
reversal. The 4 MiB cap refuses 413 instead of truncating; lower the page size.

Full reconciliation joins this paged feed to the complete local document inventory,
using bounded exceptional direct lookups. 1,000 documents need 10 page requests,
within the rate budget. A failed final page, missing inventory match or unsupported
identity prevents all-clear. Reconciliation must not advance the ordinary pull
cursor. Known drifted links remain observable but held; clients must gate cash
recording on verified current document identity and preserve pending reversals.

## Refusals

All API failures use `{error:{code,message,field?}}`.

| HTTP | Codes |
| --- | --- |
| 400 | `invalid_body`, `invalid_json`, `invalid_path` |
| 401 | `invalid_token` (including revoked) |
| 403 | `company_scope`, `scope_required`, `writes_disabled`, `demo_disabled` |
| 404 | `not_found`, `company_not_found`, `document_not_found` |
| 405 | `method_not_allowed` |
| 409 | `reference_conflict`, `document_conflict`, `payment_conflict`, `adoption_required`, `date_floor`, `custom_numbers_off` |
| 413 | `body_too_large`, `snapshot_too_large` |
| 415 | `content_type` |
| 422 | `invalid_input`, `unknown_name`, `inactive_name`, `unsupported_currency`, `unsupported_item`, `invalid_account`, `unknown_document`, `invalid_application`, `unapproved_bill`, `unverified_vendor`, `invalid_remittance`, `invalid_accounting`, `invalid_paging` |
| 429 | `rate_limit` with `Retry-After` |
| 500 | `internal_error` |

Admin data operations additionally refuse `invalid_token_settings`, `invalid_policy`
(422), and `token_not_found` (404). Browser responses follow normal Settings HTML.

## Bank review and approved item setup

Cash already recorded by an integration must be matched in bank review. Add,
direct Transfer, Backdated Bill and cash-creating Settle cannot override integration
cash evidence using “separate transaction.” Existing matching/reuse remains legal.
Grouped Undeposited Funds, direct bank receipts or outgoing bill payments require
explicit matching; a date-eligible pool containing integration cash conservatively
holds incoming creation when sufficient cash in the same direction exists. Any
eligible outgoing integration cash holds withdrawal creation: fees can make the
withdrawal exceed existing payments, and v1 does not infer a maximum fee. This can
hold an unrelated withdrawal for manual review. Direct-posting pools
stay scoped to the bank account and exclude conflicting check numbers. Matched deposit/fee
groups retain their net-amount duplicate evidence. Eligible nearby claimed cash,
including claims retained on removed bank items, also stays in the fee-aware pool
when a replacement changes the fee. Undo the old claim before matching its replacement.
A fee-adjusted match may create
an expense fee adjustment with selected existing cash, never another payment.
Adjustment cents follow the bank direction: negative for an incoming deposit's
withheld fee, positive for a fee added to an outgoing withdrawal. Uncertain groups
need manual review.
These guards use the existing finite bank matching windows, not indefinite cash
deduplication: ordinary candidates are 60 days before through 10 days after the
bank date, with the existing longer check window for individual matches. Older or
unresolved cash needs explicit review; a missing candidate is not proof cash is new.

Prepare a private manifest from the maintained client item map plus read-only QBO
metadata, normalized through the approved import name map. Shape:
`{version:1,map_sha256:<64 lowercase hex>,items:[{name,kind:'product',
income_account_name,expense_account_name,qbo_type:'NonInventory'|'Service'}]}`.
Exclude category-only mappings. Unknown names must be resolved before approval.
No real manifest belongs in git. An operator-supplied exporter requires its own tests.
For example, a sample item can map `Sample item A` to `Sample income` and
`Sample expense`; substitute only reviewed mappings from your own books.

First save a disabled policy for the destination in Settings, assigning its label
and UUID. With an operator-supplied `DATABASE_URL`, preview:

```text
node scripts/setup-integration-items.mjs --org sample --company "Sample company A" --app-map /private/item-map.json
```

Preview consumes no sequences and writes nothing. It prints counts, hash,
destination UUID/company identity and resolved account IDs/names/types. Approve
that exact evidence and canonical manifest content (not file formatting bytes).
Rerun with `--apply --approved-hash <hash>`. Apply validates the entire catalog and
creates missing items in one company-locked transaction. Identical existing mappings
are idempotent; differing/inactive/inventory items refuse without conversion or
updates. A changed destination/account/catalog requires fresh preview and approval.
Exit codes: 2 usage, 1 refusal, 0 success. There is no default database URL.
