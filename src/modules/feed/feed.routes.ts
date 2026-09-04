import { FastifyInstance } from 'fastify';
import { authGuard, requireVerifiedEmail } from '../../core/middleware/auth.middleware.js';
import { idParamSchema } from '../../core/validation/params.js';
import { FeedService } from './feed.service.js';
import { feedQuerySchema, reactSchema, sharePlanSchema } from './feed.schema.js';

const service = new FeedService();

export async function feedRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);
  app.addHook('preHandler', requireVerifiedEmail);

  app.get('/', async (request, reply) => {
    const { tab, cursor, limit } = feedQuerySchema.parse(request.query);
    const result = await service.getFeed(request.userId, tab, cursor, limit);
    return reply.send(result);
  });

  // Declared before '/:id/react' so the static segment is not captured by the
  // parameterised route.
  //
  // The only write path into the feed other than completing a task. Returns the
  // stored item so the client can confirm what was actually published rather
  // than assuming.
  app.post('/plan', async (request, reply) => {
    const body = sharePlanSchema.parse(request.body);
    const item = await service.shareDailyPlan(request.userId, body);
    return reply.status(201).send(item);
  });

  // Returns the toggled state and the new count, so the client renders what
  // the server actually recorded rather than incrementing blindly.
  app.post('/:id/react', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { emoji } = reactSchema.parse(request.body);
    const result = await service.react(id, request.userId, emoji);
    return reply.send(result);
  });
}
