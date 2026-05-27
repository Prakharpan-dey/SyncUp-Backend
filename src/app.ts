import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './core/config/env.js';
// import { errorHandler } from './core/middleware/error-handler.js';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: {
            level: env.LOG_LEVEL,
            transport: env.NODE_ENV === 'development'
                ? { target: 'pino-pretty', options: { colorize: true } }
                : undefined,
        },
    });

    // Security plugins
    await app.register(cors, { origin: true, credentials: true });
    await app.register(helmet);
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

    // Global error handler
    // app.setErrorHandler(errorHandler);

    // Health check
    app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

    // Route modules
    // await app.register(authRoutes, { prefix: '/auth' });
    // await app.register(userRoutes, { prefix: '/users' });
    // await app.register(taskRoutes, { prefix: '/tasks' });
    // await app.register(attendanceRoutes, { prefix: '/subjects' });
    // await app.register(socialRoutes, { prefix: '/friends' });
    // await app.register(feedRoutes, { prefix: '/feed' });
    // await app.register(notificationRoutes, { prefix: '/notifications' });

    return app;
}
