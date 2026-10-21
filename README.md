# Financial Books

A bookkeeping app for small businesses that works like QuickBooks Online. It keeps double-entry books for one or more
companies. You can use it on a computer or a phone, and it can be installed from Chrome as an app. It runs on your own
computer, or on a server you rent, with your own Postgres database. Nothing is shared with anyone else.

This is a **starter copy**. It comes with no data. You start your own empty books, and you can look at made-up sample
books first if you like.

Licensed under the MIT License (see `LICENSE`).

## What's included

- **Customers and sales**: customer list and customer pages, invoices, sales receipts, credit memos, estimates, receiving
  payments, deposits, statements, recurring invoices, late fees, projects, documents, PDF printing and emailing.
- **Vendors and spending**: bills (with optional approval), expenses, checks (including printing), vendor credits, paying
  bills, scheduled payments, purchase orders, and 1099 summaries.
- **Inventory**: items tracked at average cost, with stock counts and reorder points.
- **Accounting**: chart of accounts, journal entries, registers, reconciling, transfers, budgets, classes and locations,
  multiple currencies, and an audit log.
- **Reports**: Profit and Loss, Balance Sheet, Cash Flow, aging, sales and expense reports, dashboards, KPIs, a cash
  plan, saved and scheduled reports, and Excel/PDF/CSV export.
- **Several companies in one set of books**, plus **users** with roles. Each person signs in with a password and an
  authenticator app.
- **QuickBooks Online import**: brings a company's full history over from QuickBooks' export files.
- **Optional connectors**, all off until you set them up: email (your own mail server), bank feeds, text-a-receipt
  (Twilio), and AI help (Claude or OpenRouter). See [Optional connectors](#optional-connectors).

## Set it up on your computer

If you have Claude (or another coding assistant), you can hand it [SETUP-FOR-CLAUDE.md](SETUP-FOR-CLAUDE.md) and it
will run these steps for you.

### 1. Install the tools (once)

- **Node.js 22**, version 22.9 or newer: <https://nodejs.org> (the "LTS" installer). Check it with `node -v`.
- **PostgreSQL 16 or newer**: <https://www.postgresql.org/download/>. The installer asks for a password for the
  `postgres` superuser. Remember it, because you need it once in step 3. The standard installers include the contrib
  modules the app needs: migration 064 (Tax Books) runs `CREATE EXTENSION IF NOT EXISTS btree_gist`, a trusted
  extension the app's own database role can install itself.
- **Git**, if you're getting this from GitHub: <https://git-scm.com>.

### 2. Get the code and install its packages

```bash
git clone <this repository's address> financial-books
cd financial-books
npm ci
```

### 3. Make your settings file (your own secrets)

```bash
node scripts/setup-env.js
```

It asks for:

- a short name for your books, such as `mybooks`
- your name
- a sign-in password, at least 12 characters (leave it empty and it makes one for you and shows it once)
- the Postgres superuser address: `postgres://postgres:<your postgres password>@127.0.0.1:5432/postgres`

Then it:

- creates a database called `books`, and a login role `books_app` for the app with its own random password
- writes everything into a file called `.env`
- shows a **QR code**: scan it with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, and
  so on). The app then gives you the 6-digit sign-in codes.

`.env` holds your secrets. Never share it and never commit it (it's already in `.gitignore`). Back it up in a password
manager, because without its `SETTINGS_KEY`, passwords you save in Settings can't be read again. The script never
overwrites an existing `.env`. Every setting is explained in `.env.example`.

### 4. Create the tables

```bash
npm run migrate
```

### 5. Start your own books

```bash
npm run new-books -- --company "Your Company LLC" --tz America/Chicago
```

This creates your books with one empty company. The company gets a standard chart of accounts (checking, savings,
credit card, the usual income and expense accounts, plus the built-in ones such as Accounts Receivable, Accounts
Payable, Undeposited Funds and Retained Earnings) and the usual payment terms. You can change all of these afterwards.
For the time zone, use your own, for example `America/New_York`, `America/Denver` or `America/Los_Angeles`.

To add more companies later, open the gear menu and choose **Companies** (the page is `/settings/companies`).

### 6. Run it and sign in

```bash
npm run dev
```

Open <http://127.0.0.1:3000>. On the sign-in page, **leave the email empty**. That's the owner sign-in. Enter your
password and the 6-digit code from your authenticator app. Then fill in **Settings → Company** (name, address, logo).

To stop the app, press Ctrl+C. Run `npm run dev` again to start it.

### Optional: look at the sample books

The sample books are a made-up feed store with customers, vendors, inventory and a year of activity. They're kept in
their own books, called `sample`, so they never mix with yours.

```bash
npm run seed
APP_ORG=sample npm run dev            # on Windows PowerShell: $env:APP_ORG='sample'; npm run dev
```

Run plain `npm run dev` to go back to your own books. Running `npm run seed` again rebuilds the sample from scratch.

### Optional: bring a company over from QuickBooks Online

In QuickBooks, go to **Settings → Export data** and export all dates. Put the files in a folder. Read the top of
`lib/import/qbo-read.js` first: it lists the exact files the import needs. Then run:

```bash
npm run import-qbo -- "<path to the export folder>" --company "Your Company LLC" --check    # reads the files only
npm run import-qbo -- "<path to the export folder>" --company "Your Company LLC"
```

The import checks every account against QuickBooks' Trial Balance and refuses to finish if anything is off by even a
cent. It creates the company in your books, so if you only want the imported company, you don't need step 5. Keep
export files out of this folder, or in a folder named `imports/` or `exports/`, which git ignores.

## Optional connectors

All of these are **off** until you turn them on. Most are set up inside the app, and what you type there is stored
encrypted with your `SETTINGS_KEY`.

| Connector | Where | What you need |
|---|---|---|
| Email (invoices, statements, reminders) | Settings → Email | Your mail provider's SMTP server, user and password. Until then, emails are only recorded, not sent. |
| Bank feeds | `.env` (`LEDGERLINE_URL`, `LEDGERLINE_ORG_ID`), then Settings → Bank connections | Your own bank-data database (for example filled by a Plaid sync). See **[BANK-FEED-CONTRACT.md](BANK-FEED-CONTRACT.md)**, which also shows how to try it with sample data. |
| Text-a-receipt | Settings → Text receipts | Your own Twilio account and phone number. Your app must be reachable on the internet (see hosting below). |
| AI (vendor research, reading receipts and bills) | Settings → AI | An API key from Anthropic (Claude) or OpenRouter. |
| Online payments | Settings → Payments | Only a built-in **test** processor exists for now (no real money moves). |

## Run the tests

The tests need a Postgres superuser address. Each test file creates its own throwaway database and drops it afterwards.

```bash
TEST_DATABASE_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres npm test
# PowerShell: $env:TEST_DATABASE_URL='postgres://postgres:<password>@127.0.0.1:5432/postgres'; npm test
```

## Later: your own hosted copy (optional)

If you want to use it from anywhere, you can run it on any host that runs Node.js with a Postgres database, such as
Railway, Render or Fly.io, or a small server of your own. `railway.json` is an example configuration for Railway. In
outline:

1. Create a Postgres database on the host. Using its superuser address, run
   `DATABASE_URL=<superuser address> node scripts/create-app-role.js` **before** anything else. It prints the address
   of a normal login role. Use that address as the app's `DATABASE_URL`. The app refuses to run as the superuser.
2. Set the environment variables in the host's settings, never in the code: `NODE_ENV=production`,
   `DATABASE_URL`, `APP_ORG`, `SETTINGS_KEY`, `APP_LOGIN_PASSWORD_HASH`, `APP_TOTP_SECRET`,
   `APP_BASE_URL=https://<your address>`, and `TRUST_PROXY=1`. Make **new** secrets for the hosted copy:
   `node scripts/setup-env.js --database-url <the app role address> --out .env.hosted` makes them, and you then delete
   that file.
   Optional `APP_OWNER_USER_ID`: the Settings > Users account id that is the owner; leave unset to use only the blank-email owner sign-in.
   Set it only after that account exists in `APP_ORG`, using its positive integer id. The blank-email sign-in remains
   available for recovery. Leave `APP_OWNER_USER_ID` unset in the demo.
3. The start command is `npm start`. It runs the migrations, then the app. The health check is `/healthz`.
4. Run `npm run new-books -- --company "…"` once against the hosted database (or import from QuickBooks).

Keep backups of the hosted database. Most hosts offer automatic backups.

## Host a public demo (optional)

A public demo is one link that opens straight into the made-up sample books, with no sign-in, so anyone can try the
app: create invoices, bills, payments, run reports, print PDFs and download exports. Every page says
**"Demo — sample data, anyone can see and change it. Resets every night."**, and every night the database is wiped and
the clean sample is rebuilt, dated as of that day so the demo always looks current.

`DEMO_MODE=1` turns it on. These safeguards keep it away from real books:

- **The demo runs only on a database made by `npm run demo-reset`.** The reset writes a demo mark (the `demo_marker`
  table, naming the database by name and by its internal id) right after it wipes the database and rebuilds the
  sample, and it only ever wipes a database that is empty or already a clean demo. It refuses anything with data and no
  mark ("it may be real books"), a mark copied from another database, and a demo that somehow holds something a demo
  never makes. Either way nothing is changed and it exits with an error. It only empties the app's own tables (the ones
  its migrations create); data in any other table, or another table referring to the app's, makes it refuse.
- **With `DEMO_MODE=1` the app, migrations and jobs refuse to start** unless the database has the mark **and** holds
  nothing but the sample: no other books, no QuickBooks imports, no users or invitations, no email server, AI, texted
  receipts, bank connections or online payments, no stored secret of any kind, and no data in tables the app doesn't
  make. The running demo checks this again every minute and stops serving if it ever fails. They also refuse if the
  server has settings a real copy has: `SETTINGS_KEY`, the owner sign-in (`APP_LOGIN_PASSWORD_HASH`,
  `APP_TOTP_SECRET`, `APP_OWNER_USER_ID`), `DEV_NO_AUTH`, bank feeds (`LEDGERLINE_URL`), `PAYMENTS_TEST_MODE`, `BOOKS_MODE`, or an `APP_ORG`
  other than `sample`. Without `SETTINGS_KEY` nothing secret can be saved at all.
- **Normal books refuse a demo database**: without `DEMO_MODE=1`, the app, migrations and jobs won't open a database
  that carries the mark, and `npm run new-books`, `npm run import-qbo`, `scripts/tax-baseline-import.mjs` and
  `scripts/repair-bank-dims.js` won't write into one. So nobody ends up
  keeping real books in a database that is wiped every night.
- `DEMO_MODE` must be exactly `1` (or `0`, or unset). Anything else stops the app on purpose.

What these checks can't do: tell real customers or transactions typed into the demo (or restored into it by hand) from
a visitor's. So give the demo a **new, dedicated database**, never restore real data into it, and remember that
anything typed into the demo is visible to everyone until the next reset.

**What a visitor can't do** (each shows a clear "turned off in this public demo" page instead), because it could store
a secret, reach the outside world, change how the server runs, or change things for every other visitor:

| Closed | Why |
|---|---|
| Settings → Users (people, invitations, sign-in resets), Companies (adding companies) | Everyone is the same "Demo visitor" (the name in the audit log); there is no sign-in to manage. |
| Changing Settings → Company (name, details, logo) | The company's identity is on every page and PDF. It can be looked at. |
| Changing Settings → Accounting, Sales, Messages, Form styles and Currencies, and a report's default settings | Every visitor shares them; they'd change how every page and report reads for everyone. They can be looked at. |
| Undoing a reconciliation, and "change it anyway" on a reconciled transaction | Reconciled history stays as the sample has it. |
| Settings → Email, and every send | Emails, statements and reminders are recorded on the customer's or vendor's page, never sent. |
| Settings → AI, AI bill reading and research (vendor research on a bank line too) | No AI provider is ever called. |
| Settings → Text receipts, and the Twilio webhook | No texts in or out. |
| Settings → Bank connections, bank refresh | No bank data. |
| Settings → Payments, pay links, payment webhooks | No online payments. |
| Tax Books' shared parties (owners, trusts, their tax IDs) | Tax IDs are secrets, and a demo can store none. The rest of the tax setup works. |
| Every import (customers, products, accounts, vendors, bank rules), asking a vendor for their details, invitation and vendor links | Nothing comes in from outside in bulk or goes out to someone. |
| File uploads (documents, attachments, files on a bank line, logos, bill reading) | A public demo must not become a place to store and hand out files. Refused before the file is read. |

Also: daily jobs (recurring transactions, late fees, reminders, scheduled payments and report emails) don't run;
sign-in and sign-out pages just go to the app; every response, downloads included, carries `X-Robots-Tag: noindex` and
`/robots.txt` disallows everything. Limits, all per 10 minutes: each visitor address may make 120 changes (3,000
across all visitors) and open 150 reports, exports, PDFs, spreadsheets, ZIPs or searches (3,000 across all visitors),
and at most 4 of those are built at once. A report spans at most about 10 years; print and send batches, and bank review
batches ("all N matching" counts as N), take 25 at a time; the usual 64 KB limit per form still applies. Visitor sessions are kept in memory (the 2,000 most recently used,
each remembering at most 100 submitted forms) and all start afresh after the nightly reset.

The per-visitor limits use the visitor's address as the host's proxy reports it (`TRUST_PROXY=1`: the last
`X-Forwarded-For` entry). That's only trustworthy if the app can be reached solely through that proxy and the proxy
appends the real address; check this on your host before relying on the per-visitor limits. The overall limits hold
regardless (per running app instance; run one).

### On Railway

You need three things in one Railway project: a Postgres database, the demo app, and a cron job for the nightly reset.
Use a **new** project with a **new, empty** database, never one that holds books.

1. **Postgres.** Add a Postgres database. Using its superuser address (the `DATABASE_URL` Railway shows), run once from
   your computer: `DATABASE_URL=<superuser address> node scripts/create-app-role.js`. It prints the address of a
   normal login role; that address is the `DATABASE_URL` for both services below.
2. **The demo app.** Add a service from this repository. In its settings set **Config file path** to
   `railway.demo.json` (it starts with `npm run demo-start`'s steps: build the demo if the database is new, migrate,
   start the app; health check `/healthz`). Generate a public domain. Variables:
   - `DEMO_MODE=1`
   - `NODE_ENV=production`
   - `APP_BASE_URL=https://<the public domain>`
   - `TRUST_PROXY=1` (so the per-visitor limit sees each visitor's address, not Railway's proxy)
   - `DATABASE_URL=<the app role address from step 1>`

   Don't set `SETTINGS_KEY`, `APP_LOGIN_PASSWORD_HASH`, `APP_TOTP_SECRET`, `APP_OWNER_USER_ID`, `APP_ORG`, `BOOKS_MODE`, `LEDGERLINE_URL` or
   `PAYMENTS_TEST_MODE`: the demo refuses to start with them.
3. **The first reset** happens on its own: on a new, empty database the app's start command builds the demo before it
   starts. (By hand, from your computer: `DEMO_MODE=1 DATABASE_URL=<app role address> npm run demo-reset`.)
4. **The nightly reset.** Add a second service from the same repository, set its **Config file path** to
   `railway.demo-reset.json` (start command `node scripts/demo-reset.js`, cron schedule `0 8 * * *`: every day at
   08:00 UTC, about 2–3 a.m. in US Central time; change it in the service's settings if you like), and give it the same
   `DEMO_MODE=1`, `NODE_ENV=production` and `DATABASE_URL`. It needs no domain. Each run wipes and rebuilds in one
   transaction (a failure leaves the previous day's demo as it was; any new schema migrations are applied just before), retries briefly if the app is busy saving, and exits
   non-zero on failure so it shows as failed in Railway.

Other hosts work the same way: one app (`npm run demo-start`), one Postgres database, and a daily scheduled
`npm run demo-reset`.

Operations for self-hosted copies: see [the runbooks](docs/runbooks/). The rebuild tools refuse public demo databases.

## How it's built (for whoever maintains it)

- Node 22, plain `node:http`, `pg`, server-rendered HTML. There is no front-end framework and no build step.
- `migrations/` holds plain SQL, applied in order by `npm run migrate`. `lib/data/` holds all database access,
  `lib/views/` the pages, `lib/reports/` the reports, and `services/app/` the routes. Tests are in `test/` (`node:test`).
- Money is stored as whole cents. Every transaction posts balanced debits and credits, and the database refuses
  anything out of balance.
- `BOOKS_MODE=practice` marks a practice copy kept alongside another system. It sends no emails or texts, takes no
  payments and runs no automatic jobs. Leave it unset for normal books.
- `DEMO_MODE=1` is the public demo: `lib/domain/demo.js` (what's closed), `lib/data/demo.js` (the database interlock and
  the reset), `scripts/demo-reset.js`, `migrations/053_demo_marker.sql` and `054`. Leave it unset for normal books.
