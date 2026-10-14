# Setup instructions for Claude (or another coding assistant)

You are setting up Financial Books for its owner on their own computer. Follow these steps in order. Stop and ask the
owner whenever a step says **ASK**. Never invent values for secrets. Never print or copy the contents of `.env`. Never
commit `.env`, database dumps or QuickBooks export files.

1. **Check the tools.**
   - `node -v` must print v22.9 or newer. If not, ask the owner to install Node.js 22 LTS from nodejs.org, then continue.
   - Postgres 16+ must be running. Try `psql --version`, and check that the server answers on 127.0.0.1:5432. If it
     isn't installed, ask the owner to install it from postgresql.org.
   - **ASK** for the `postgres` superuser password they chose when installing. Use it only on the command line in
     step 3, and don't save it anywhere.

2. **Install packages:** run `npm ci` in the repository folder.

3. **Make `.env`.** First **ASK** for three things: a short lowercase name for the books (letters, digits and `_`, e.g.
   `mybooks`), the owner's name, and whether they want to type their own sign-in password (12+ characters) or have
   one generated. Then run it interactively so the owner types the password themselves:
   ```
   node scripts/setup-env.js --org <name> --name "<owner name>" --admin-url postgres://postgres:<pw>@127.0.0.1:5432/postgres
   ```
   If you can't run it interactively, add `--yes`. A password is then generated and printed once. Tell the owner to
   save it in a password manager right away.
   - The script prints a QR code and an `otpauth://` link. Tell the owner to scan it (or add the link) in an
     authenticator app. They need the 6-digit codes to sign in.
   - If it says a database or role already exists, run it again with `--db-name <other>` / `--db-role <other>`.
     **Never** delete an existing database without asking.
   - Remind the owner to back up `.env` (a password manager is ideal). Without its `SETTINGS_KEY`, passwords saved in
     Settings can't be read.

4. **Create the tables:** `npm run migrate`. It should end with `ledger: … companies checked`.

5. **ASK** for the company's name and time zone (e.g. `America/Chicago`), and whether they're bringing a company over
   from QuickBooks Online.
   - New, empty books: `npm run new-books -- --company "<Company Name>" --tz <time zone>`
   - From QuickBooks: follow "Bring a company over from QuickBooks Online" in README.md. Run with `--check` first.
     Put the export files in a folder named `imports/`, which git ignores.

6. **Optional sample books** (only if the owner wants to look around first): `npm run seed`. To view them, start the
   app with `APP_ORG=sample` (PowerShell: `$env:APP_ORG='sample'; npm run dev`).

7. **Run the tests** (optional, takes several minutes):
   `TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres npm test`. Every test should pass.

8. **Start it:** `npm run dev`, then tell the owner to open http://127.0.0.1:3000. To sign in, they **leave the email
   empty**, type their password, and type the 6-digit code from the authenticator app. Then they fill in
   **Settings → Company**.

9. **Connectors stay off** unless the owner asks for them. Email, AI and text receipts are set up in the app's
   Settings. Bank feeds need their own bank-data database: read BANK-FEED-CONTRACT.md before doing anything there.

If something fails, read the error message. The app's messages are written in plain language. Fix the cause rather
than working around a safety check. For example, the app refuses to run as the `postgres` superuser on purpose.
