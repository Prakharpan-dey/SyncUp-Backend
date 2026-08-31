import { vi } from 'vitest';

/**
 * Global test setup.
 *
 * Two jobs, both of which must happen before any `src/` module is imported.
 *
 * 1. Satisfy `env.ts`, which calls `envSchema.parse(process.env)` at module load
 *    and throws on a missing DATABASE_URL, REDIS_URL or JWT_ACCESS_SECRET.
 *
 * 2. Guarantee the suite cannot reach a real service. `env.ts` also imports
 *    `dotenv/config`, so the developer's real `.env` — pointing at production
 *    Neon and Railway Redis — would otherwise be loaded. dotenv never overwrites
 *    a key that is already set, so assigning these first wins outright.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'fatal';

// Syntactically valid so the URL validators pass, and unroutable so a missed
// mock fails fast with a connection error instead of touching production.
process.env.DATABASE_URL =
  'postgresql://test:test@127.0.0.1:1/syncup_test_never_connected';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

process.env.JWT_ACCESS_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.JWT_ACCESS_EXPIRY = '15m';
process.env.JWT_REFRESH_EXPIRY_DAYS = '30';
process.env.PUBLIC_APP_URL = 'http://localhost:3000';

// Left unset on purpose: the email worker must degrade to "skip" rather than
// attempt a real Resend delivery from a test run.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.SMTP_PASS;

/**
 * Redis is a module-level singleton that dials out the moment it is imported,
 * so it is replaced globally rather than per-file. Without this every suite
 * logs `ECONNREFUSED 127.0.0.1:1` and risks an unhandled error event.
 *
 * The stub covers the commands actually used: the auth guard's account cache,
 * the rate limiter, and BullMQ's connection handles.
 */
vi.mock('../src/core/redis/redis.js', () => {
  const client = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    status: 'ready',
  };
  return {
    redis: client,
    createWorkerConnection: () => client,
    workerPollingOptions: { drainDelay: 30, stalledInterval: 300_000 },
  };
});
