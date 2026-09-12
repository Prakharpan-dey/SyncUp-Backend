import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

import { errorHandler } from '../../src/core/middleware/error-handler.js';
import { AppError } from '../../src/core/errors/app-errors.js';

const { login } = vi.hoisted(() => ({ login: vi.fn() }));

vi.mock('../../src/modules/auth/auth.service.js', () => ({
  AuthService: class {
    login = login;
  },
}));
vi.mock('../../src/core/middleware/auth.middleware.js', () => ({
  authGuard: async () => {},
  requireVerifiedEmail: async () => {},
  invalidateAccountCache: vi.fn(),
}));

const { authRoutes } = await import('../../src/modules/auth/auth.routes.js');

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  login.mockRejectedValue(new AppError(401, 'Invalid credentials', 'UNAUTHORIZED'));

  // Not buildTestApp(): this test is about the limiter, so it registers one
  // (in-memory) before the routes, which is when per-route limits are wired.
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
});

const attempt = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'WrongPass123x' },
  });

describe('the sign-in rate limit', () => {
  it('stops the sixth attempt at one email from one address', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await attempt('rhea@example.com')).statusCode).toBe(401);
    }
    expect((await attempt('rhea@example.com')).statusCode).toBe(429);
  });

  /**
   * The bug: the limiter ran before the body was parsed, so the email half of
   * its key was always empty and every email from one address shared five
   * attempts — a whole campus network, or before the proxy fix, the whole app.
   */
  it('gives a different email from the same address its own budget', async () => {
    for (let i = 0; i < 5; i++) await attempt('rhea@example.com');
    expect((await attempt('rhea@example.com')).statusCode).toBe(429);

    expect((await attempt('arjun@example.com')).statusCode).toBe(401);
    expect(login).toHaveBeenLastCalledWith(
      'arjun@example.com',
      'WrongPass123x',
      undefined,
      expect.any(String),
    );
  });
});
