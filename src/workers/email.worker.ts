import { Worker, Job } from 'bullmq';
import { redis } from '../core/redis/redis.js';
import { env } from '../core/config/env.js';

const worker = new Worker('email', async (job: Job) => {
  const { to, subject, html } = job.data;

  // Only send if SMTP is configured
  if (!env.SMTP_HOST || !env.SMTP_USER) {
    console.log(`[EmailWorker] SMTP not configured, skipping: ${subject} → ${to}`);
    return;
  }

  // Dynamic import to avoid crashes when nodemailer isn't needed
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: false,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: env.SMTP_FROM ?? 'SyncUp <noreply@syncup.app>',
    to, subject, html,
  });

  console.log(`[EmailWorker] Sent: ${subject} → ${to}`);
}, { connection: redis });

worker.on('failed', (job, err) => {
  console.error(`[EmailWorker] Job ${job?.id} failed:`, err);
});

export default worker;
