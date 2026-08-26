import { Worker, Job } from 'bullmq';
import { redis } from '../core/redis/redis.js';
import { env } from '../core/config/env.js';

const DEFAULT_PORT = 587;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

type Mail = { from: string; to: string; subject: string; html: string };

/**
 * Resend's HTTP API key, if we can send over HTTPS instead of SMTP.
 *
 * This is the preferred path: Railway and most other PaaS providers block
 * outbound SMTP ports (25/465/587) as an anti-spam measure, so a perfectly
 * valid SMTP config still dies with ETIMEDOUT on connect. Port 443 always works.
 *
 * Falls back to SMTP_PASS when the host is Resend — it is the same credential,
 * so an existing SMTP setup starts using the API with no new configuration.
 */
function resendApiKey(): string | undefined {
  if (env.RESEND_API_KEY) return env.RESEND_API_KEY;
  if (env.SMTP_HOST?.includes('resend.com')) return env.SMTP_PASS;
  return undefined;
}

async function sendViaResendApi(mail: Mail, apiKey: string) {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.text();
  if (!response.ok) {
    // Resend puts the actionable reason in the body — most often an
    // unverified sender domain.
    throw new Error(`Resend API ${response.status}: ${body}`);
  }

  return (JSON.parse(body) as { id?: string }).id ?? 'unknown';
}

async function sendViaSmtp(mail: Mail) {
  const port = env.SMTP_PORT ?? DEFAULT_PORT;
  const nodemailer = await import('nodemailer');

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // 465 is implicit TLS and needs secure:true; 587 is STARTTLS and needs
    // secure:false. Hardcoding false meant port 465 spoke plaintext to a
    // TLS-only socket and hung until it timed out.
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    // Fail fast instead of sitting on a dead socket.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  const info = await transporter.sendMail(mail);
  return info.messageId;
}

const worker = new Worker('email', async (job: Job) => {
  const { to, subject, html } = job.data;
  const apiKey = resendApiKey();

  if (!apiKey && (!env.SMTP_HOST || !env.SMTP_USER)) {
    console.warn(
      `[EmailWorker] SKIPPED "${subject}" → ${to}. No delivery method configured: ` +
        'set RESEND_API_KEY, or SMTP_HOST + SMTP_USER. ' +
        'These must be on the service running the worker, not just the API.',
    );
    return;
  }

  const from = env.SMTP_FROM ?? 'SyncUp <noreply@zeusdotdev.app>';
  const mail: Mail = { from, to, subject, html };
  const via = apiKey ? 'resend-api' : 'smtp';

  try {
    const id = apiKey
      ? await sendViaResendApi(mail, apiKey)
      : await sendViaSmtp(mail);
    console.log(`[EmailWorker] Sent "${subject}" → ${to} via ${via} (id: ${id})`);
  } catch (err) {
    // Surface `from` — an unverified sender domain is the usual cause and is
    // invisible from the job payload alone.
    console.error(
      `[EmailWorker] FAILED "${subject}" → ${to} | via=${via} from=${from}`,
      err instanceof Error ? err.message : err,
    );
    throw err; // let BullMQ record the failure and retry
  }
}, { connection: redis });

worker.on('failed', (job, err) => {
  console.error(`[EmailWorker] Job ${job?.id} failed:`, err?.message ?? err);
});

export default worker;
