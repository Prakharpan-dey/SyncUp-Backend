import { FastifyInstance } from 'fastify';
import { authGuard, requireVerifiedEmail } from '../../core/middleware/auth.middleware.js';
import {
  idParamSchema,
  groupMemberParamsSchema,
  groupRequestParamsSchema,
  groupInviteParamsSchema,
  inviteParamsSchema,
  tokenParamSchema,
} from '../../core/validation/params.js';
import { SocialService } from '../social/social.service.js';
import { createGroupSchema, createGroupInviteSchema } from '../social/social.schema.js';

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

  // Invites: an owner or admin asks someone in, and they accept or decline.
  // The static /invites routes are matched before /:id, as Fastify prefers
  // static segments to parameters.
  app.get('/invites', async (request, reply) => {
    const invites = await service.getMyInvites(request.userId);
    return reply.send(invites);
  });

  app.post('/invites/:inviteId/accept', async (request, reply) => {
    const { inviteId } = inviteParamsSchema.parse(request.params);
    const result = await service.acceptInvite(inviteId, request.userId);
    return reply.send(result);
  });

  app.post('/invites/:inviteId/decline', async (request, reply) => {
    const { inviteId } = inviteParamsSchema.parse(request.params);
    const result = await service.declineInvite(inviteId, request.userId);
    return reply.send(result);
  });

  app.get('/:id/invites', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const invites = await service.getGroupInvites(id, request.userId);
    return reply.send(invites);
  });

  app.post('/:id/invites', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = createGroupInviteSchema.parse(request.body);
    const result = await service.inviteToGroup(id, request.userId, body);
    return reply.status(201).send(result);
  });

  app.delete('/:id/invites/:inviteId', async (request, reply) => {
    const { id, inviteId } = groupInviteParamsSchema.parse(request.params);
    await service.cancelInvite(id, inviteId, request.userId);
    return reply.status(204).send();
  });

  // Join requests. Opening an invite link no longer admits anyone — it files a
  // request that an owner or admin approves or rejects. The service enforces
  // who may review; these routes only parse.
  app.get('/:id/requests', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const requests = await service.getJoinRequests(id, request.userId);
    return reply.send(requests);
  });

  app.post('/:id/requests/:requestId/approve', async (request, reply) => {
    const { id, requestId } = groupRequestParamsSchema.parse(request.params);
    const result = await service.approveJoinRequest(id, requestId, request.userId);
    return reply.send(result);
  });

  app.post('/:id/requests/:requestId/reject', async (request, reply) => {
    const { id, requestId } = groupRequestParamsSchema.parse(request.params);
    const result = await service.rejectJoinRequest(id, requestId, request.userId);
    return reply.send(result);
  });

  app.post('/join/:token', async (request, reply) => {
    const { token } = tokenParamSchema.parse(request.params);
    const result = await service.joinGroupByToken(token, request.userId);
    return reply.send(result);
  });

  // Removing yourself is leaving the group; removing anyone else is an owner
  // action. Both are the same URL because the client already calls it for both.
  app.delete('/:id/members/:userId', async (request, reply) => {
    const { id, userId } = groupMemberParamsSchema.parse(request.params);
    if (userId === request.userId) {
      await service.leaveGroup(id, request.userId);
    } else {
      await service.removeMember(id, userId, request.userId);
    }
    return reply.status(204).send();
  });
}
