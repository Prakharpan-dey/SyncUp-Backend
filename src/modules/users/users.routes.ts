import { FastifyInstance } from 'fastify';
import { authGuard } from '../../core/middleware/auth.middleware.js';
import { UsersService } from './users.service.js';
import { updateProfileSchema, searchUsersSchema, blockUserSchema } from './users.schema.js';

const service = new UsersService();

export async function userRoutes(app: FastifyInstance) {
  // All user routes require auth
  app.addHook('preHandler', authGuard);

  // GET /users/me
  app.get('/me', async (request, reply) => {
    const user = await service.getProfile(request.userId);
    return reply.send(user);
  });

  // PATCH /users/me
  app.patch('/me', async (request, reply) => {
    const body = updateProfileSchema.parse(request.body);
    const user = await service.updateProfile(request.userId, body);
    return reply.send(user);
  });

  // GET /users/search?q=
  app.get('/search', async (request, reply) => {
    const { q } = searchUsersSchema.parse(request.query);
    const results = await service.searchUsers(q, request.userId);
    return reply.send(results);
  });

  // POST /users/block
  app.post('/block', async (request, reply) => {
    const { user_id } = blockUserSchema.parse(request.body);
    await service.blockUser(request.userId, user_id);
    return reply.status(204).send();
  });
}
