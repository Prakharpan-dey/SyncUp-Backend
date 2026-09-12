import { z } from 'zod';
import { FastifyInstance } from 'fastify';

import { authGuard } from '../../core/middleware/auth.middleware.js';
import { idParamSchema } from '../../core/validation/params.js';
import { TaskSeriesService } from './task-series.service.js';
import { createSeriesSchema, updateSeriesSchema } from './task-series.schema.js';

const service = new TaskSeriesService();

export async function taskSeriesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);

  app.get('/', async (request, reply) => {
    return reply.send(await service.listSeries(request.userId));
  });

  app.post('/', async (request, reply) => {
    const body = createSeriesSchema.parse(request.body);
    return reply.status(201).send(await service.createSeries(request.userId, body));
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = updateSeriesSchema.parse(request.body);
    return reply.send(await service.updateSeries(id, request.userId, body));
  });

  // ?pending=delete also removes the pending days; completed ones always stay.
  app.delete('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { pending } = z
      .object({ pending: z.enum(['delete']).optional() })
      .parse(request.query ?? {});
    await service.deleteSeries(id, request.userId, { deletePending: pending === 'delete' });
    return reply.status(204).send();
  });
}
