import { FastifyInstance } from 'fastify';
import { authGuard, requireVerifiedEmail } from '../../core/middleware/auth.middleware.js';
import { idParamSchema } from '../../core/validation/params.js';
import { FeedService } from './feed.service.js';
import { feedQuerySchema, reactSchema, commentSchema } from './feed.schema.js';

const service = new FeedService();

export async function feedRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);
  app.addHook('preHandler', requireVerifiedEmail);

  app.get('/', async (request, reply) => {
    const { tab, cursor, limit } = feedQuerySchema.parse(request.query);
    const result = await service.getFeed(request.userId, tab, cursor, limit);
    return reply.send(result);
  });

  app.post('/:id/react', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { emoji } = reactSchema.parse(request.body);
    await service.react(id, request.userId, emoji);
    return reply.status(204).send();
  });

  app.post('/:id/comment', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { text } = commentSchema.parse(request.body);
    await service.comment(id, request.userId, text);
    return reply.status(204).send();
  });
}
