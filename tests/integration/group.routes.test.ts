import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, fakeAuth } from '../helpers/test-app.js';

const CALLER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';

const leaveGroup = vi.fn().mockResolvedValue(undefined);
const removeMember = vi.fn().mockResolvedValue(undefined);
const generateInvite = vi.fn().mockResolvedValue({ invite_token: 'tok' });
const verifyMembership = vi.fn().mockResolvedValue(undefined);
const getGroups = vi.fn().mockResolvedValue([]);
const getGroupDetail = vi.fn().mockResolvedValue({ id: GROUP });
const getGroupMembers = vi.fn().mockResolvedValue([]);
const createGroup = vi.fn().mockResolvedValue({ id: GROUP });
const joinGroupByToken = vi.fn().mockResolvedValue({ joined: true });

vi.mock('../../src/modules/social/social.service.js', () => ({
  SocialService: class {
    leaveGroup = leaveGroup;
    removeMember = removeMember;
    generateInvite = generateInvite;
    verifyMembership = verifyMembership;
    getGroups = getGroups;
    getGroupDetail = getGroupDetail;
    getGroupMembers = getGroupMembers;
    createGroup = createGroup;
    joinGroupByToken = joinGroupByToken;
  },
}));

vi.mock('../../src/core/middleware/auth.middleware.js', () => ({
  authGuard: async (req: { userId: string; userEmailVerified: boolean }) => {
    req.userId = CALLER;
    req.userEmailVerified = true;
  },
  requireVerifiedEmail: async () => {},
  invalidateAccountCache: vi.fn(),
}));

const { groupRoutes } = await import('../../src/modules/social/group.routes.js');

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildTestApp(groupRoutes, '/groups');
});

/**
 * `leaveGroup` existed but no route ever called it. The only DELETE went to
 * removeMember, which 403s a non-owner and 400s an owner removing themselves —
 * so nobody in any group could leave, while the app offered a LEAVE GROUP
 * button wired directly to it.
 */
describe('DELETE /groups/:id/members/:userId', () => {
  it('treats removing yourself as leaving', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/groups/${GROUP}/members/${CALLER}`,
    });

    expect(res.statusCode).toBe(204);
    expect(leaveGroup).toHaveBeenCalledWith(GROUP, CALLER);
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('treats removing somebody else as an owner action', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/groups/${GROUP}/members/${OTHER}`,
    });

    expect(res.statusCode).toBe(204);
    expect(removeMember).toHaveBeenCalledWith(GROUP, OTHER, CALLER);
    expect(leaveGroup).not.toHaveBeenCalled();
  });

  it('surfaces the service’s 403 rather than masking it as a 500', async () => {
    const { AppError } = await import('../../src/core/errors/app-errors.js');
    removeMember.mockRejectedValueOnce(
      new AppError(403, 'Only the group owner can remove members', 'FORBIDDEN'),
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/groups/${GROUP}/members/${OTHER}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a non-uuid member id before reaching the service', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/groups/${GROUP}/members/not-a-uuid`,
    });

    expect(res.statusCode).toBe(422);
    expect(removeMember).not.toHaveBeenCalled();
    expect(leaveGroup).not.toHaveBeenCalled();
  });
});

describe('POST /groups/:id/invite', () => {
  // A bodyless POST: the client must not announce a JSON body it never sends,
  // and the route must not require one.
  it('succeeds with no request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/groups/${GROUP}/invite`,
    });

    expect(res.statusCode).toBe(200);
    expect(generateInvite).toHaveBeenCalledWith(GROUP, CALLER);
  });
});
