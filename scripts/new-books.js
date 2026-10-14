import { createPool } from '../lib/db.js';
import { startBooks } from '../lib/data/companies.js';

// Starts your own, empty books: the organization named by APP_ORG and its first company, with a standard chart of
// accounts and payment terms. Run once, after npm run migrate:
//   npm run new-books -- --company "Your Company LLC" [--tz America/Chicago]
// More companies: Settings → Companies in the app.
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const company = opt('company');
if (!company) {
  console.error('Give the company’s name: npm run new-books -- --company "Your Company LLC" [--tz America/Chicago]');
  process.exit(1);
}
const pool = createPool();
try {
  const { entityId } = await startBooks(pool, { slug: process.env.APP_ORG, orgName: opt('org-name'), companyName: company,
    timeZone: opt('tz') ?? 'America/Chicago' });
  console.log(`new-books: “${company}” is ready (company ${entityId}) in the books “${process.env.APP_ORG}”. Start the app with npm run dev.`);
} catch (error) {
  console.error(`new-books failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
