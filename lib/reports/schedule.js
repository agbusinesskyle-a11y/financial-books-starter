import { buildReport, renderReport, getEntity } from './run.js';
import { nextRun } from './saved.js';
import { reportByKey } from './registry.js';
import { canAccess } from '../domain/roles.js';

// Emails saved reports that are due (part of the daily jobs). Dates like "Last month" are worked out on the send day.
// A failed send keeps the date so the next run tries again, and the error shows on Custom reports.
export async function runReportSchedules(pool, { orgId, entityId, today, timeZone, mailer, ownerUserId = null }) {
  const { rows } = await pool.query(
    `SELECT s.*, u.active AS owner_active, u.role AS owner_role,
            u.password_hash IS NOT NULL AND u.totp_enc IS NOT NULL AS owner_has_credentials FROM saved_report s
       LEFT JOIN app_user u ON u.user_id = (CASE WHEN s.owner_key ~ '^\\d+$' THEN s.owner_key::bigint END) AND u.org_id = s.org_id
      WHERE s.org_id = $1 AND s.entity_id = $2 AND s.sched_freq <> 'none' AND s.sched_next <= $3::date ORDER BY s.saved_id`,
    [orgId, entityId, today]);
  const out = { sent: 0, failed: 0 };
  if (!rows.length) return out;
  const entity = await getEntity(pool, { orgId, entityId });
  let m = null;
  for (const s of rows) {
    try {
      // Numeric ownership stays account-specific. Only an eligible account in this organization
      // receives the server-designated owner role; reset or inactive accounts cannot send.
      const accountRole = s.owner_active && s.owner_has_credentials
        ? s.owner_key === String(ownerUserId) ? 'admin' : s.owner_role
        : null;
      const role = s.owner_key === 'owner' ? 'admin' : accountRole;
      if (!role || !canAccess(role, 'POST', `/reports/r/${s.report_key}/email`) || (reportByKey(s.report_key)?.adminOnly && role !== 'admin')) {
        await pool.query(`UPDATE saved_report SET sched_freq = 'none', sched_next = NULL, last_error = $2 WHERE saved_id = $1`,
          [s.saved_id, `Stopped: ${s.owner_name} can no longer email this report.`]);
        out.failed++;
        continue;
      }
      m ??= await mailer();
      const query = Object.fromEntries(new URLSearchParams(s.query));
      const { report } = await buildReport(pool, { orgId, entityId, key: s.report_key, query, today, timeZone });
      if (!report) throw new Error('The report no longer exists.');
      const file = await renderReport(report, entity, s.sched_format);
      await m.send({ to: s.sched_to, subject: `${s.name} — ${entity.name}`,
        text: `${s.name} (${report.subtitle}) from ${entity.name} is attached.\n\nThis email was scheduled by ${s.owner_name} in Financial Books.`,
        attachments: [{ filename: file.filename, content: file.body, contentType: file.type }] });
      await pool.query('UPDATE saved_report SET last_sent_at = now(), last_error = NULL, sched_next = $2 WHERE saved_id = $1',
        [s.saved_id, nextRun(s.sched_freq, s.sched_day, today)]);
      out.sent++;
    } catch (error) {
      await pool.query('UPDATE saved_report SET last_error = $2 WHERE saved_id = $1', [s.saved_id, String(error.message).slice(0, 300)]);
      out.failed++;
    }
  }
  return out;
}
