import { buildApp } from './app.js';
import { env } from './core/config/env.js';

async function start() {
    const app = await buildApp();

    try {
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        app.log.info(`Server running on port ${env.PORT} [${env.NODE_ENV}]`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }

    // Graceful shutdown
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, async () => {
            app.log.info(`Received ${signal}, shutting down gracefully...`);
            await app.close();
            process.exit(0);
        });
    }
}

start();
