import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { SocialService } = await import('../../src/modules/social/social.service.js');

const OWNER = '11111111-0000-0000-0000-000000000001';
const MEMBER = '22222222-0000-0000-0000-000000000002';
const SUCCESSOR = '33333333-0000-0000-0000-000000000003';
const GROUP = '44444444-0000-0000-0000-000000000004';

const group = (over: Record<string, unknown> = {}) => ({
  id: GROUP,
  name: 'DBMS Study Group',
  ownerId: OWNER,
  isPublic: false,
  inviteToken: 'tok',
  createdAt: new Date(),
  ...over,
});

const membership = (userId: string) => ({
  id: 'm-1',
  groupId: GROUP,
  userId,
  role: 'member',
  joinedAt: new Date(),
});

let social: InstanceType<typeof SocialService>;
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  social = new SocialService();
});

/**
 * Leaving was impossible for everyone in a group: the only DELETE route went to
 * removeMember, which rejects a non-owner outright and refuses an owner
 * removing themselves — while the app showed a LEAVE GROUP button wired to it.
 */
describe('SocialService.leaveGroup', () => {
  it('lets an ordinary member leave', async () => {
    dbMock.queueMany([group()], [membership(MEMBER)]);
    await expect(social.leaveGroup(GROUP, MEMBER)).resolves.toBeUndefined();
    expect(dbMock.called('delete')).toBe(true);
  });

  it('does not touch ownership when a non-owner leaves', async () => {
    dbMock.queueMany([group()], [membership(MEMBER)]);
    await social.leaveGroup(GROUP, MEMBER);
    // Only the membership delete — no ownership handover.
    expect(dbMock.trace.filter((c) => c.method === 'update')).toHaveLength(0);
  });

  it('404s for a group that does not exist', async () => {
    dbMock.queueRows([]);
    await expect(social.leaveGroup(GROUP, MEMBER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  /**
   * 404 rather than 403 for a non-member: a stranger probing group ids should
   * not be able to tell an existing group from one that never existed.
   */
  it('404s — not 403 — for someone who is not in the group', async () => {
    dbMock.queueMany([group()], []);
    await expect(social.leaveGroup(GROUP, MEMBER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  /**
   * An owner who leaves must hand the group on, or it survives with an owner
   * who is not in it — nobody could then invite or remove anyone.
   */
  it('promotes the longest-tenured member when the owner leaves', async () => {
    dbMock.queueMany(
      [group()],
      [membership(OWNER)],
      [], // the awaited membership delete
      [{ userId: SUCCESSOR }],
    );

    await social.leaveGroup(GROUP, OWNER);

    // groups.ownerId reassigned, and that member's role raised to owner.
    const sets = dbMock.trace
      .filter((c) => c.method === 'set')
      .map((c) => c.args[0] as Record<string, unknown>);
    expect(sets).toContainEqual(expect.objectContaining({ ownerId: SUCCESSOR }));
    expect(sets).toContainEqual(expect.objectContaining({ role: 'owner' }));
  });

  it('deletes the group when the last member leaves', async () => {
    dbMock.queueMany(
      [group()],
      [membership(OWNER)],
      [], // membership delete
      [], // no successor
    );

    await social.leaveGroup(GROUP, OWNER);

    // Two deletes: the membership, then the now-empty group.
    expect(dbMock.trace.filter((c) => c.method === 'delete')).toHaveLength(2);
    expect(dbMock.trace.filter((c) => c.method === 'update')).toHaveLength(0);
  });
});

describe('SocialService.removeMember', () => {
  it('lets the owner remove someone', async () => {
    dbMock.queueRows([group()]);
    await expect(social.removeMember(GROUP, MEMBER, OWNER)).resolves.toBeUndefined();
    expect(dbMock.called('delete')).toBe(true);
  });

  it('403s when a non-owner tries to remove someone', async () => {
    dbMock.queueRows([group()]);
    await expect(social.removeMember(GROUP, SUCCESSOR, MEMBER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  // Removing yourself is leaving, which has its own succession rules.
  it('400s when the owner targets themselves', async () => {
    dbMock.queueRows([group()]);
    await expect(social.removeMember(GROUP, OWNER, OWNER)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('404s for an unknown group', async () => {
    dbMock.queueRows([]);
    await expect(social.removeMember(GROUP, MEMBER, OWNER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('does not delete anything when authorization fails', async () => {
    dbMock.queueRows([group()]);
    await expect(social.removeMember(GROUP, SUCCESSOR, MEMBER)).rejects.toThrow();
    expect(dbMock.called('delete')).toBe(false);
  });
});

describe('SocialService.generateInvite', () => {
  // Scoped to the owner in the UPDATE itself: a member generating invites could
  // hand out permanent access the owner never authorized.
  it('403s when the update matches no owner-owned row', async () => {
    dbMock.queueRows([]);
    await expect(social.generateInvite(GROUP, MEMBER)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('returns the new token for the owner', async () => {
    dbMock.queueRows([{ inviteToken: 'fresh-token' }]);
    await expect(social.generateInvite(GROUP, OWNER)).resolves.toEqual({
      invite_token: 'fresh-token',
    });
  });
});
