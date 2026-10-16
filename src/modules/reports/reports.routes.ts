import { FastifyInstance } from 'fastify';
import { authGuard } from '../../core/middleware/auth.middleware.js';
import { ReportsService } from './reports.service.js';
import { createReportSchema } from './reports.schema.js';

const service = new ReportsService();

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);

  // Each report mails the support inbox, so it gets a tighter budget than the
  // global limit.
  app.post('/', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const body = createReportSchema.parse(request.body);
    const result = await service.create(request.userId, body);
    return reply.status(201).send(result);
  });
}
