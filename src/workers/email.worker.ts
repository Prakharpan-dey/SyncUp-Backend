import { Worker, Job } from 'bullmq';
import { redis } from '../core/redis/redis.js';
import { env } from '../core/config/env.js';

const DEFAULT_PORT = 587;

const worker = new Worker('email', async (job: Job) => {
  const { to, subject, html } = job.data;

  if (!env.SMTP_HOST || !env.SMTP_USER) {
    console.warn(
      `[EmailWorker] SKIPPED "${subject}" → ${to}. ` +
        `SMTP_HOST=${env.SMTP_HOST ? 'set' : 'MISSING'} ` +
        `SMTP_USER=${env.SMTP_USER ? 'set' : 'MISSING'}. ` +
        'Set these on the service running the worker, not just the API.',
    );
    return;
  }

  const port = env.SMTP_PORT ?? DEFAULT_PORT;
  const nodemailer = await import('nodemailer');

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // 465 is implicit TLS and needs secure:true; 587 is STARTTLS and needs
    // secure:false. Hardcoding false meant port 465 spoke plaintext to a
    // TLS-only socket and hung until it timed out (ETIMEDOUT on CONN).
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    // Fail fast instead of sitting on a dead socket for two minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  const from = env.SMTP_FROM ?? 'SyncUp <onboarding@resend.dev>';

  try {
    const info = await transporter.sendMail({ from, to, subject, html });
    console.log(`[EmailWorker] Sent "${subject}" → ${to} (id: ${info.messageId})`);
  } catch (err) {
    // Providers reject unverified sender domains, so surface `from` — it is the
    // usual culprit and is invisible from the job payload alone.
    console.error(
      `[EmailWorker] FAILED "${subject}" → ${to} | from=${from} ` +
        `host=${env.SMTP_HOST}:${port} secure=${port === 465}`,
      err,
    );
    throw err; // let BullMQ record the failure and retry
  }
}, { connection: redis });

worker.on('failed', (job, err) => {
  console.error(`[EmailWorker] Job ${job?.id} failed:`, err?.message ?? err);
});

export default worker;
