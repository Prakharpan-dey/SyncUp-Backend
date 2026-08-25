import { FastifyInstance } from 'fastify';
import { authGuard } from '../../core/middleware/auth.middleware.js';
import { idParamSchema } from '../../core/validation/params.js';
import { NotificationsService } from './notifications.service.js';

const service = new NotificationsService();

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);

  app.get('/', async (request, reply) => {
    const notifications = await service.list(request.userId);
    return reply.send(notifications);
  });

  app.patch('/:id/read', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.markAsRead(id, request.userId);
    return reply.status(204).send();
  });

  app.patch('/read-all', async (request, reply) => {
    await service.markAllAsRead(request.userId);
    return reply.status(204).send();
  });

  app.get('/unread-count', async (request, reply) => {
    const result = await service.getUnreadCount(request.userId);
    return reply.send(result);
  });
}
