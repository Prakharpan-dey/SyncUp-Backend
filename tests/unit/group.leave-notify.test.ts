import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
const enqueueNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/core/queues/notification.queue.js', () => ({ enqueueNotification }));

const { SocialService } = await import('../../src/modules/social/social.service.js');

const OWNER = '11111111-0000-0000-0000-000000000001';
const MEMBER = '22222222-0000-0000-0000-000000000002';
const GROUP = '44444444-0000-0000-0000-000000000004';
const ADMIN = '55555555-0000-0000-0000-000000000005';

const group = () => ({
  id: GROUP, name: 'DBMS Study Group', ownerId: OWNER,
  isPublic: false, inviteToken: 'tok', createdAt: new Date(), updatedAt: new Date(),
});
const membership = (userId: string, role = 'member') => ({
  id: 'm-' + userId.slice(0, 2), groupId: GROUP, userId, role, joinedAt: new Date(),
});

/** notifyMemberLeft is fire-and-forget; let it finish before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));
const recipients = () => enqueueNotification.mock.calls.map(([n]) => n.userId).sort();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
});

/** Leaving used to tell nobody. */
describe('leaving a group', () => {
  it('tells the owner and admins who left', async () => {
    dbMock.queueMany(
      [group()], [membership(MEMBER)],               // the group, and you are in it
      [],                                            // your membership removed
      [{ ownerId: OWNER }],                          // who runs it now
      [{ displayName: 'Rhea', username: 'rhea' }],   // who left
      [{ userId: OWNER }, { userId: ADMIN }],        // its owner and admins
    );

    await new SocialService().leaveGroup(GROUP, MEMBER);
    await settle();

    expect(recipients()).toEqual([OWNER, ADMIN].sort());
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Rhea left DBMS Study Group',
      deepLink: `/feed/groups/${GROUP}`,
    }));
  });

  it('tells the new owner when the owner is the one who left', async () => {
    dbMock.queueMany(
      [group()], [membership(OWNER, 'owner')],
      [],                          // owner's membership removed
      [{ userId: ADMIN }],         // longest-tenured member takes over
      [], [],                      // group and role updated
      [{ ownerId: ADMIN }],        // who runs it now
      [{ displayName: 'Owner', username: 'owner' }],
      [{ userId: ADMIN }],
    );

    await new SocialService().leaveGroup(GROUP, OWNER);
    await settle();

    expect(recipients()).toEqual([ADMIN]);
  });

  it('tells nobody when the last member leaves and the group goes', async () => {
    dbMock.queueMany(
      [group()], [membership(OWNER, 'owner')],
      [],   // membership removed
      [],   // nobody left to take over
      [],   // group deleted
      [],   // so there is no group to report to
    );

    await new SocialService().leaveGroup(GROUP, OWNER);
    await settle();

    expect(enqueueNotification).not.toHaveBeenCalled();
  });
});
