import nodemailer from 'nodemailer';

// Mailer interface: { kind, from, replyTo, send({ to, subject, text, attachments }) -> { status: 'sent' | 'logged' } }.
// send() throws when the mail server refuses; callers record that as a failed message.
// Which mailer a company gets comes from its Settings → Email row (see lib/data/settings.js).

const formatFrom = (name, email) => (name ? `"${name.replace(/["\\]/g, '')}" <${email}>` : email);

// Records what would have been sent and sends nothing.
export function createLogMailer({ fromName = null, fromEmail = null, env = process.env } = {}) {
  return {
    kind: 'log',
    from: fromEmail ? formatFrom(fromName, fromEmail) : null,
    async send(message) {
      if (env.MAIL_LOG === '1') console.log(`mail (log only): to=${message.to} subject=${JSON.stringify(message.subject)} attachments=${message.attachments?.length ?? 0}`);
      return { status: 'logged' };
    },
  };
}

// Sends through the company's own SMTP server. `makeTransport` is injectable for tests.
export function createSmtpMailer({ fromName, fromEmail, replyTo, host, port, security, user, password }, { makeTransport = nodemailer.createTransport } = {}) {
  const transport = makeTransport({
    host, port, secure: security === 'tls', requireTLS: security === 'starttls',
    auth: user ? { user, pass: password } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  const from = formatFrom(fromName, fromEmail);
  return {
    kind: 'smtp',
    from,
    async send({ to, cc = null, bcc = null, subject, text, attachments = [] }) {
      await transport.sendMail({ from, to, cc: cc || undefined, bcc: bcc || undefined, replyTo: replyTo || undefined, subject, text, attachments });
      return { status: 'sent' };
    },
  };
}
