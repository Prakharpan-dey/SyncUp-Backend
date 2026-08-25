import { FastifyInstance } from 'fastify';
import { authGuard, requireVerifiedEmail } from '../../core/middleware/auth.middleware.js';
import {
  idParamSchema,
  groupMemberParamsSchema,
  tokenParamSchema,
} from '../../core/validation/params.js';
import { SocialService } from '../social/social.service.js';
import { createGroupSchema } from '../social/social.schema.js';

const service = new SocialService();

export async function groupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);
  app.addHook('preHandler', requireVerifiedEmail);

  app.get('/', async (request, reply) => {
    const groups = await service.getGroups(request.userId);
    return reply.send(groups);
  });

  app.post('/', async (request, reply) => {
    const body = createGroupSchema.parse(request.body);
    const group = await service.createGroup(request.userId, body);
    return reply.status(201).send(group);
  });

  app.get('/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.verifyMembership(id, request.userId);
    const group = await service.getGroupDetail(id, request.userId);
    return reply.send(group);
  });

  app.get('/:id/members', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    await service.verifyMembership(id, request.userId);
    const members = await service.getGroupMembers(id);
    return reply.send(members);
  });

  app.post('/:id/invite', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const result = await service.generateInvite(id, request.userId);
    return reply.send(result);
  });

  app.post('/join/:token', async (request, reply) => {
    const { token } = tokenParamSchema.parse(request.params);
    const result = await service.joinGroupByToken(token, request.userId);
    return reply.send(result);
  });

  app.delete('/:id/members/:userId', async (request, reply) => {
    const { id, userId } = groupMemberParamsSchema.parse(request.params);
    await service.removeMember(id, userId, request.userId);
    return reply.status(204).send();
  });
}
