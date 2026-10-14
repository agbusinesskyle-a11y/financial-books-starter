# Bank feed contract

Financial Books can show your bank and card transactions on **Transactions → Bank transactions**, where you add or match
each one to the books. It doesn't talk to banks itself. It reads them from a separate Postgres database: **the
bank-data database** (a ledgerline-compatible schema). Something else fills that database, for example your own
Plaid sync. Financial Books only reads it.

This page describes exactly what Financial Books reads, so you can build that database and fill it from Plaid (or any
other source). The code that reads it is `lib/bankfeed/source.js` (the queries) and `lib/bankfeed/pull.js` (what happens
to the rows). `lib/bankfeed/sample.js` builds a complete working example of the schema; when this page and that file
disagree, the file is right.

> Bank feeds are optional. Leave `LEDGERLINE_URL` empty and the app works without them. You enter or import
> transactions by hand instead.

Financial Books has no built-in Plaid connector. Plaid (or another source) fills the bank-data database, and Financial
Books reads from it.

---

## 1. Settings (environment variables)

| Variable | What it is |
|---|---|
| `LEDGERLINE_URL` | Postgres address of the bank-data database, as a **read-only** login role (see §6). Empty means bank feeds are off. |
| `LEDGERLINE_ORG_ID` | **Your bank-data org id**: a uuid. Every row in the bank-data database carries an `org_id`, and Financial Books reads only the rows with this one. At startup the app saves it on the books named by `APP_ORG`. |
| `BANK_PULLS` | `0` stops the automatic pull (every 15 minutes, pulling a company when its accounts have synced since the last pull, and at least every 6 hours). The **Refresh** button in Settings → Bank connections still works. |

Once these are set, restart the app and go to **Settings → Bank connections**. Pick which bank-data company is this
company (the link), then match each bank account to an account in your chart of accounts and give it an optional start
date. Only matched accounts are pulled, and only from their start date.

## 2. Ids and tenancy

- Every id is a **uuid**: `org_id`, `entity_id`, `account_id`, `transaction_id`.
- **`org_id`** is the tenant, meaning your bank-data org id. Pick one uuid for yourself (for example
  `SELECT gen_random_uuid()`) and put it on every row.
- **`entity_id`** is a company, meaning a business that owns bank accounts. One Financial Books company links to one
  bank-data company.
- **`transaction_id` must be stable.** The same bank transaction keeps the same id forever: when it goes from pending to
  posted, when the bank corrects it, and when you re-sync. Financial Books keys on it. With Plaid, keep your own uuid
  per transaction. Plaid's `pending_transaction_id` tells you which pending item a posted one replaces, so the posted
  version can reuse the pending item's uuid. You can also derive the uuid from Plaid's `transaction_id`.

## 3. Sign conventions

- **Transaction `amount`**: `numeric(14,2)`, signed from the **account holder's view**. Money **out** of the account is
  **negative**: a check, a debit, a card purchase. Money **in** is **positive**: a deposit, interest, a payment *to* a
  credit card, or a refund on a card.
  - Plaid uses the opposite convention (positive means money out). **Negate Plaid's `amount`** when you store it.
- **Balances** (§4.4) follow the account's orientation:
  - For checking, savings and money market accounts, `current` is the money **in** the account. It is positive when the
    account has money.
  - For credit cards, lines of credit, loans and mortgages, `owed_positive` is the amount **owed**, as a positive
    number.
- **Statement balances** for verified months (§5) follow the same orientation: money in the account, or amount owed.
- Amounts are read as text and converted to cents exactly. Use `numeric`, never a float type.
- Only **USD** is brought in. Other currencies are counted and skipped with a warning.

## 4. What Financial Books reads

You need three schemas: `core`, `verify` and `serve`. The columns below are the ones Financial Books reads. Your tables
can have more columns. Types are what `sample.js` uses.

### 4.1 `core.entity`: companies

| Column | Type | Notes |
|---|---|---|
| `org_id` | uuid | your bank-data org id |
| `entity_id` | uuid | the company id |
| `display_name` | text | shown when linking |
| `legal_name`, `legal_form` | text | optional, read but not required |
| `has_books` | bool | only `true` companies can be linked |
| `active` | bool | only `true` companies can be linked |

### 4.2 `core.account`: bank, card and loan accounts

| Column | Type | Notes |
|---|---|---|
| `org_id` | uuid | |
| `account_id` | uuid | stable per account |
| `display_name` | text | fallback name (`serve.v_account_coverage.display_name` is used first) |
| `institution_name` | text | e.g. the bank's name |
| `mask` | text | last 4 digits. Texted receipts also use it to find the card |
| `kind` | text | one of `checking`, `savings`, `money_market`, `credit_card`, `line_of_credit`, `loan`, `mortgage`, `brokerage`, `other`. It decides which kind of books account it can be matched to |
| `currency` | char(3) | `USD` (null counts as USD) |
| `status` | text | `placeholder` rows are ignored. Use `active` |

### 4.3 `core.account_entity`: who owns each account, by date

| Column | Type | Notes |
|---|---|---|
| `org_id`, `account_id`, `entity_id` | uuid | |
| `valid` | daterange | when this company owned the account, e.g. `daterange('2020-01-01', NULL)` for "since 2020" |

An account appears for a company if it has ever owned it. The bank balance is shown only while the company owns it
today (`valid @> current_date`). If one company owns all your accounts, give each account one row with an open-ended
range.

### 4.4 `serve` views

Financial Books reads these views by name. You can build them the way `sample.js` does, on top of the core tables.

**`serve.v_account_coverage`**: one row per account.

| Column | Notes |
|---|---|
| `org_id`, `account_id` | |
| `display_name` | preferred account name |
| `connection_state` | e.g. `healthy`. Anything else is shown as a warning ("Connection: login_required") |
| `verification_state` | `verified`, `invalidated` or `unverified` (shown on the account) |
| `last_acceptance_at` | timestamptz: when your sync last finished for this account. A newer time than the last pull triggers a pull |

**`serve.v_cash_position`** (checking, savings and money market accounts) and **`serve.v_debt_position`** (credit
cards, lines of credit, loans and mortgages): the latest balance for each account.

| Column | Notes |
|---|---|
| `org_id`, `account_id` | |
| `current` (cash) / `owed_positive` (debt) | numeric(14,2), see §3 |
| `observed_at` | timestamptz: when the balance was read |
| `balance_stale` | bool: the balance is old (the sample uses older than 36 hours) |

**`serve.v_transaction_current`** (posted) and **`serve.v_transaction_pending`** (pending): one row per *active*
transaction, with the company that owned the account on that day.

| Column | Type | Notes |
|---|---|---|
| `org_id` | uuid | |
| `entity_id` | uuid | the company that owned the account on `posted_date` (join `core.account_entity` with `valid @> posted_date`) |
| `transaction_id` | uuid | stable (§2) |
| `account_id` | uuid | |
| `amount` | numeric(14,2) | signed, money out negative (§3) |
| `currency` | char(3) | |
| `posted_date` | date | for pending items, the expected or authorized date |
| `authorized_date` | date | optional |
| `pending` | bool | `false` in `v_transaction_current`, `true` in `v_transaction_pending` |
| `description_raw` | text | what the bank says. This is the description shown and learned from |
| `original_description` | text | optional (Plaid `original_description`) |
| `merchant_name` | text | optional (Plaid `merchant_name`) |
| `pfc_primary`, `pfc_detailed` | text | optional category hints (Plaid `personal_finance_category.primary` / `.detailed`) |
| `payment_channel` | text | optional (`online`, `in store`, `other`) |
| `check_number` | text | optional. Used to match checks written in the books |
| `counterparties` | jsonb | optional (Plaid `counterparties`) |
| `revision` | int | starts at 1. **Increase it** whenever the bank changes the transaction |
| `scope` | text | optional, defaults to `included` (stored for information) |

### 4.5 `verify` tables (for verified months, §5)

`serve.v_verified_intervals` (`org_id`, `account_id`, `period` daterange, `certification_id`, `certified_at`) joined to
`verify.certification` (`org_id`, `id`, `recon_run_id`), `verify.recon_run` (`org_id`, `id`, `statement_id`) and
`verify.statement` (`org_id`, `id`, `opening_balance`, `closing_balance`). You need these tables even if you never
verify a month. Leave them empty in that case.

## 5. Pending, revisions and removals

Every pull reads the full current list for the company and compares it with what the books already have.

- **New `transaction_id`**: it appears in Bank transactions for review.
- **Pending to posted**: keep the **same `transaction_id`**, set `pending = false`, and bump `revision`.
- **Bank correction** (amount, date or description changed): keep the id and **bump `revision`**. A lower revision
  than the one the books already have is ignored. If someone had already added or matched the item and the amount or
  date changed, it's flagged "changed by the bank" for review.
- **Removed by the bank** (Plaid `removed` transactions): take it out of the `serve` transaction views. In the sample
  that means setting `core.transaction.status = 'removed'`. Don't delete history. A removed item still waiting for
  review disappears. One already added to the books stays and is flagged "removed by the bank".
- **Safety guard**: if an account suddenly returns no transactions, or more than half of its transactions (and more
  than 20) vanish at once, nothing is removed and the pull shows a warning. This usually means a broken connection, not
  real removals.

## 6. Verified months (optional)

A verified month is an account-month that your bank-data side has checked against the bank statement. On the Bank
transactions page and in Reconcile, Financial Books shows "Verified to <date>". For each verified month it also shows
whether the books agree: statement closing balance − cleared books activity − items still waiting = difference
(should be $0.00). Reconcile can also start from a verified month with its date and ending balance filled in.

To mark a month verified:

1. Insert a `verify.statement` row with `period` = `daterange('2026-01-01', '2026-02-01')` (start included, end
   **excluded**, so the end is the first day of the next month), plus `opening_balance` and `closing_balance` (§3
   orientation).
2. Insert a `verify.recon_run` row pointing at that statement.
3. Insert a `verify.certification` row with the same `period`, pointing at the run.

`serve.v_verified_intervals` lists the certifications that haven't been invalidated (`verify.invalidation` with no
superseding certification). Skip this whole section if you don't verify statements.

## 7. The read-only role

Financial Books opens every session read-only (`default_transaction_read_only=on`). Still, give it its own login role
that can only read:

```sql
CREATE ROLE bank_reader LOGIN PASSWORD '<a long random password>';
GRANT CONNECT ON DATABASE <your bank-data db> TO bank_reader;
GRANT USAGE ON SCHEMA core, verify, serve TO bank_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA core, verify, serve TO bank_reader;   -- includes the views
ALTER DEFAULT PRIVILEGES IN SCHEMA core, verify, serve GRANT SELECT ON TABLES TO bank_reader;
ALTER ROLE bank_reader SET default_transaction_read_only = on;
```

Then set `LEDGERLINE_URL=postgres://bank_reader:<password>@<host>:<port>/<db>`. Hosted Postgres usually needs
`?sslmode=require` at the end. Keep the password in your host's secret settings, never in the code.

## 8. Mapping Plaid to this schema

| Plaid | Here |
|---|---|
| an Item's accounts (`/accounts/get`) | `core.account` (`kind` from `type`/`subtype`, `mask`, `name` as `display_name`, institution name) plus one `core.account_entity` row |
| `/transactions/sync` `added` / `modified` | upsert `core.transaction` by your stable id. `amount = -plaid.amount`. `posted_date = date`, `authorized_date`, `pending`, `name`/`original_description`, `merchant_name`, `personal_finance_category`, `payment_channel`, `check_number`, `counterparties`. Bump `revision` on every modify |
| `/transactions/sync` `removed` | `status = 'removed'` (it leaves the views) |
| balances (`/accounts/balance/get`) | a new `core.balance_observation` row: `current` for cash accounts; for credit and loans the amount owed (Plaid's `balances.current` is already the amount owed there) |
| end of each sync | `last_acceptance_at = now()` for the synced accounts (that triggers the next pull) |
| Item errors (`ITEM_LOGIN_REQUIRED`, …) | `connection_state` (anything other than `healthy` shows a warning) |

The simplest working design is to copy `SAMPLE_SCHEMA` from `lib/bankfeed/sample.js` into your bank-data database. It
creates the tables and the exact `serve` views. Your Plaid sync then writes into `core.*` (replace
`core.sample_connection` with your own connection table if you like, keeping `v_account_coverage`'s columns).

## 9. Try it locally with the sample

This builds a sample bank-data database from the sample books. It needs no bank, Plaid or internet:

```bash
npm run seed                                   # sample books (org "sample")
npm run bank-sample -- --admin-url postgres://postgres@127.0.0.1:5432/postgres
# copy the two printed lines (LEDGERLINE_URL=…, LEDGERLINE_ORG_ID=…) into .env
APP_ORG=sample npm run dev                     # PowerShell: $env:APP_ORG='sample'; npm run dev
```

Then go to **Settings → Bank connections**, link the sample company, match Operating Checking, Savings and Business
Card, press **Refresh**, and open **Transactions → Bank transactions**. You'll see a pending charge, a corrected one, a
removed one, card purchases nobody entered, and verified months on checking. `npm test` covers the same flow
(`test/bankfeed.test.js`).

When you're done with the sample, remove the two lines from `.env` (or point them at your own bank-data database).
