import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';

import { errorHandler } from '../../src/core/middleware/error-handler.js';

/**
 * A minimal Fastify carrying one route plugin and the real error handler.
 *
 * Deliberately not `buildApp()`: the full app also wires CORS, helmet and the
 * Redis-backed rate limiter, none of which these tests are about, and all of
 * which add failure modes unrelated to the route under test. Using the real
 * error handler matters though — the status a route produces is only half the
 * contract; how a thrown AppError is rendered is the other half.
 *
 * Requests are driven with `app.inject()` rather than supertest, so nothing
 * binds a port.
 */
export async function buildTestApp(
  routes: FastifyPluginAsync,
  prefix: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(routes, { prefix });
  await app.ready();
  return app;
}

/**
 * Stands in for `authGuard` / `requireVerifiedEmail`.
 *
 * The real guards read a JWT and then hit the database and Redis; signing a
 * token per test would prove nothing about the route's own logic. These set the
 * same two properties the guards decorate the request with.
 */
export function fakeAuth(userId: string, emailVerified = true) {
  return async (request: { userId: string; userEmailVerified: boolean }) => {
    request.userId = userId;
    request.userEmailVerified = emailVerified;
  };
}
