import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './core/config/env.js';
import { redis } from './core/redis/redis.js';
import { errorHandler } from './core/middleware/error-handler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { userRoutes } from './modules/users/users.routes.js';
import { taskRoutes } from './modules/tasks/tasks.routes.js';
import { attendanceRoutes } from './modules/attendance/attendance.routes.js';
import { socialRoutes } from './modules/social/social.routes.js';
import { groupRoutes } from './modules/social/group.routes.js';
import { feedRoutes } from './modules/feed/feed.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Keep credentials out of logs even if LOG_LEVEL is turned up in production.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refresh_token',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // Security plugins
  await app.register(cors, { origin: false });
  await app.register(helmet);
  // Parses urlencoded bodies, which the browser-facing password-reset form
  // submits. Every other endpoint is JSON.
  await app.register(formbody);
  // Redis-backed so counters survive restarts and are shared across replicas.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis,
  });

  // Global error handler
  app.setErrorHandler(errorHandler);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Route modules
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(taskRoutes, { prefix: '/tasks' });
  await app.register(attendanceRoutes, { prefix: '/subjects' });
  await app.register(socialRoutes, { prefix: '/friends' });
  await app.register(groupRoutes, { prefix: '/groups' });
  await app.register(feedRoutes, { prefix: '/feed' });
  await app.register(notificationRoutes, { prefix: '/notifications' });

  return app;
}
