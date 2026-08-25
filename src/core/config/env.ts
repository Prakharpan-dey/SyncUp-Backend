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

    // Base for links emailed to users (verification, password reset).
    // Custom scheme by default so links open the app without a registered
    // domain; switch to https://<your-domain> once App Links are verified.
    PUBLIC_APP_URL: z.string().default('syncup://'),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_FROM: z.string().optional(),
});

// This will throw at startup if validation fails — intentional
export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
