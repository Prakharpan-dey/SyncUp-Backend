import { FastifyInstance } from 'fastify';
import { authGuard, requireVerifiedEmail } from '../../core/middleware/auth.middleware.js';
import { idParamSchema } from '../../core/validation/params.js';
import { SocialService } from './social.service.js';
import { sendFriendRequestSchema, respondFriendRequestSchema, createGroupSchema } from './social.schema.js';

const service = new SocialService();

export async function socialRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);
  // Friends are part of the social surface — verified email required, so an
  // unverified account cannot pose as someone by signing up with their address.
  app.addHook('preHandler', requireVerifiedEmail);

  // Friends
  app.get('/', async (request, reply) => {
    const friends = await service.getFriends(request.userId);
    return reply.send(friends);
  });

  app.get('/requests', async (request, reply) => {
    const requests = await service.getPendingRequests(request.userId);
    return reply.send(requests);
  });

  app.post('/request', async (request, reply) => {
    const { addressee_id } = sendFriendRequestSchema.parse(request.body);
    const result = await service.sendFriendRequest(request.userId, addressee_id);
    return reply.status(201).send(result);
  });

  app.patch('/request/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { status } = respondFriendRequestSchema.parse(request.body);
    const result = await service.respondToRequest(id, request.userId, status);
    return reply.send(result);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.removeFriend(id, request.userId);
    return reply.status(204).send();
  });

  // Everyone the caller has blocked, for the app's Blocked users screen.
  app.get('/blocked', async (request, reply) => {
    const blocked = await service.listBlocked(request.userId);
    return reply.send(blocked);
  });

  // Undo a block. Scoped to the blocker — the blocked party cannot reach this.
  app.delete('/block/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.unblockUser(id, request.userId);
    return reply.status(204).send();
  });
}
