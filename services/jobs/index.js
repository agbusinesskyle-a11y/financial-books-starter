import { fileURLToPath } from 'node:url';
import { isPractice, checkBooksMode } from '../../lib/domain/practice.js';
import { createPool } from '../../lib/db.js';
import { todayIn } from '../../lib/domain/dates.js';
import { runRecurring } from '../../lib/data/recurring.js';
import { runLateFees } from '../../lib/data/latefees.js';
import { runScheduledPayments } from '../../lib/data/payables.js';
import { sendTransaction, runReminders } from '../../lib/data/messages.js';
import { mailerFor } from '../../lib/data/settings.js';
import { ValidationError, logActivity } from '../../lib/data/writes.js';
import { getAccountingSettings } from '../../lib/data/accounting.js';
import { setDateFormat } from '../../lib/domain/dates.js';
import { setShowAccountNumbers } from '../../lib/views/accounts.js';
import { withDisplay } from '../../lib/domain/display.js';
import { runReportSchedules } from '../../lib/reports/schedule.js';
import { runManagementSchedules } from '../../lib/reports/management.js';

// Daily jobs for every company: recurring transactions (customer and vendor), late fees, invoice reminders, scheduled bill payments, scheduled report emails. Each company's "today" is in
// its own time zone. Safe to run as often as you like (hourly from the app, or `npm run jobs`):
// every step is keyed by (template, date) or (invoice, date). A Postgres advisory lock keeps two
// runners from overlapping.
const LOCK_KEY = 815_215_001;

export async function runDailyJobs({ pool, env = process.env, now = () => new Date(), makeTransport, mailer = null, log = () => {} }) {
  // A practice copy creates, charges and sends nothing on its own (lib/domain/practice.js).
  if (isPractice(env)) { log('jobs: practice copy — daily jobs are off'); return { practice: true }; }
  const lock = await pool.connect();
  try {
    const { rows: [{ ok }] } = await lock.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!ok) { log('jobs: another run is in progress; skipping'); return { skipped: true }; }
    try {
      const { rows: entities } = await pool.query('SELECT org_id, entity_id, name, time_zone FROM entity ORDER BY org_id, entity_id');
      const summary = { created: 0, reminded: 0, failed: 0, sent: 0, lateFees: 0, billsPaid: 0, paymentsFailed: 0, remindersSent: 0, remindersFailed: 0, reportsSent: 0, reportsFailed: 0 };
      for (const e of entities) await withDisplay(async () => {
        const scope = { orgId: e.org_id, entityId: e.entity_id };
        // PDFs and emails use this company's date format and account-number setting.
        const acct = await getAccountingSettings(pool, scope);
        setDateFormat(acct.dateFormat);
        setShowAccountNumbers(acct.showAccountNumbers);
        const today = todayIn(e.time_zone, now());
        const runs = await runRecurring(pool, { ...scope, today });
        for (const r of runs) summary[r.outcome]++;
        const toSend = runs.filter(r => r.autoSend);
        if (toSend.length) {
          let m;
          try { m = mailer ?? await mailerFor(pool, { ...scope, env, makeTransport }); } catch (error) {
            if (!(error instanceof ValidationError)) throw error;
            log(`jobs: ${e.name}: auto-send skipped: ${error.message}`);
          }
          for (const r of m ? toSend : []) {
            try {
              if (await sendTransaction(pool, m, { ...scope, txnId: r.txnId, actor: 'system', origin: env.APP_BASE_URL ? env.APP_BASE_URL.replace(/\/$/, '') : null }) !== 'failed') summary.sent++;
            } catch (error) {
              if (!(error instanceof ValidationError)) throw error;
              const { rows: [t] } = await pool.query('SELECT customer_id, doc_number FROM txn WHERE txn_id = $1', [r.txnId]);
              await logActivity(pool, { orgId: e.org_id, customerId: t.customer_id, txnId: r.txnId, actor: 'system', kind: 'email_failed',
                summary: `${t.doc_number} wasn’t sent automatically: ${error.message}` });
            }
          }
        }
        summary.lateFees += await runLateFees(pool, { ...scope, today });
        try {
          const r = await runReminders(pool, async () => mailer ?? mailerFor(pool, { ...scope, env, makeTransport }), { ...scope, today });
          summary.remindersSent += r.sent;
          summary.remindersFailed += r.failed;
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          log(`jobs: ${e.name}: reminders skipped: ${error.message}`);
        }
        const pays = await runScheduledPayments(pool, { ...scope, today });
        summary.billsPaid += pays.paid;
        summary.paymentsFailed += pays.failed;
        // Saved reports on an email schedule.
        const reports = await runReportSchedules(pool, { ...scope, today, timeZone: e.time_zone, mailer: async () => mailer ?? mailerFor(pool, { ...scope, env, makeTransport }) });
        summary.reportsSent += reports.sent;
        summary.reportsFailed += reports.failed;
        const packs = await runManagementSchedules(pool, { ...scope, today, timeZone: e.time_zone, mailer: async () => mailer ?? mailerFor(pool, { ...scope, env, makeTransport }) });
        summary.reportsSent += packs.sent;
        summary.reportsFailed += packs.failed;
      });
      log(`jobs: ${JSON.stringify(summary)}`);
      return summary;
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  checkBooksMode();
  const pool = createPool();
  try {
    await runDailyJobs({ pool, log: console.log });
  } catch (error) {
    console.error(`jobs failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
