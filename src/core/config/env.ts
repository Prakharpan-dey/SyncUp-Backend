import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_EXPIRY_DAYS: z.coerce.number().default(30),

    DATABASE_POOL_MAX: z.coerce.number().default(10),

    // Public base URL of THIS API. Emailed verification and reset links point
    // here, because they are completed in the browser — a custom scheme would
    // render as a blank page in desktop webmail.
    PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),

    // Resend's HTTP API key. Preferred over SMTP because many PaaS providers
    // (Railway included) block outbound SMTP ports entirely. Defaults to
    // SMTP_PASS when the host is Resend, since it is the same credential.
    RESEND_API_KEY: z.string().optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
});

// This will throw at startup if validation fails — intentional
export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
