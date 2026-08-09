import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    // Not configured yet — this is fine for local dev. Alerts still get
    // saved to the database and shown on the dashboard either way.
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

export async function sendAlertEmail({ subject, message }) {
  const t = getTransporter();

  if (!t) {
    console.log(`[EMAIL SKIPPED - not configured] Would have sent: "${subject}" — ${message}`);
    return;
  }

  try {
    await t.sendMail({
      from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_EMAIL_TO,
      subject: `[Server Monitor] ${subject}`,
      text: message,
    });
    console.log(`[EMAIL SENT] ${subject}`);
  } catch (err) {
    console.error("Failed to send alert email", err.message);
  }
}