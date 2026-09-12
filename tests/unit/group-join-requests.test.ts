import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
const enqueueNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/core/queues/notification.queue.js', () => ({ enqueueNotification }));

const { SocialService } = await import('../../src/modules/social/social.service.js');
const { groupMembers, groupJoinRequests } = await import('../../src/core/db/schema/index.js');

const OWNER = '11111111-0000-0000-0000-000000000001';
const MEMBER = '22222222-0000-0000-0000-000000000002';
const JOINER = '33333333-0000-0000-0000-000000000003';
const ADMIN = '55555555-0000-0000-0000-000000000005';
const GROUP = '44444444-0000-0000-0000-000000000004';
const REQUEST = '66666666-0000-0000-0000-000000000006';

const group = () => ({
  id: GROUP, name: 'DBMS Study Group', ownerId: OWNER,
  isPublic: false, inviteToken: 'tok', createdAt: new Date(), updatedAt: new Date(),
});
const membership = (userId: string, role = 'member') => ({
  id: 'm-' + userId.slice(0, 2), groupId: GROUP, userId, role, joinedAt: new Date(),
});
const joinRequest = () => ({
  id: REQUEST, groupId: GROUP, userId: JOINER, createdAt: new Date('2026-09-12T08:00:00Z'),
});
const joinerUser = { id: JOINER, username: 'rhea', displayName: 'Rhea', photoUrl: null };

/** Which table each insert/delete in the trace was aimed at. */
const writesTo = (method: 'insert' | 'delete') =>
  dbMock.trace.filter((c) => c.method === method).map((c) => c.args[0]);

let social: InstanceType<typeof SocialService>;
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  social = new SocialService();
});

/**
 * An invite link used to admit anyone who had it. It now files a request that
 * an owner or admin has to approve.
 */
describe('joining through an invite link', () => {
  it('files a request instead of adding the member', async () => {
    dbMock.queueMany(
      [group()],               // group by token
      [],                      // not already a member
      [],                      // no invite waiting
      [joinRequest()],         // request created
      [{ displayName: 'Rhea', username: 'rhea' }], // requester, for the notification
      [],                      // no admins besides the owner
    );

    const result = await social.joinGroupByToken('tok', JOINER);

    expect(result).toMatchObject({ group_id: GROUP, status: 'pending' });
    expect(writesTo('insert')).toEqual([groupJoinRequests]);
    expect(writesTo('insert')).not.toContain(groupMembers);
  });

  it('tells the owner a request is waiting', async () => {
    dbMock.queueMany([group()], [], [], [joinRequest()], [{ displayName: 'Rhea', username: 'rhea' }], []);

    await social.joinGroupByToken('tok', JOINER);

    expect(enqueueNotification).toHaveBeenCalledTimes(1);
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER,
      type: 'group_request',
      deepLink: `/feed/groups/${GROUP}`,
    }));
  });

  it('tells admins too, once each', async () => {
    dbMock.queueMany(
      [group()], [], [], [joinRequest()], [{ displayName: 'Rhea', username: 'rhea' }],
      [{ userId: OWNER }, { userId: ADMIN }], // owner is also listed as a member
    );

    await social.joinGroupByToken('tok', JOINER);

    const recipients = enqueueNotification.mock.calls.map(([n]) => n.userId).sort();
    expect(recipients).toEqual([OWNER, ADMIN].sort());
  });

  /** A double tap or a reopened link should read as "still pending". */
  it('treats asking again as pending, without pinging the admins again', async () => {
    dbMock.queueMany([group()], [], []); // insert hit the unique constraint

    const result = await social.joinGroupByToken('tok', JOINER);

    expect(result.status).toBe('pending');
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  /** Invited already: opening the code is a yes, not a request to approve. */
  it('accepts a waiting invite instead of filing a request', async () => {
    const invite = { id: 'inv-1', groupId: GROUP, inviteeId: JOINER, invitedBy: OWNER, createdAt: new Date() };
    dbMock.queueMany(
      [group()], [], [invite],                    // group, not a member, invite waiting
      [invite], [], [], [],                        // acceptInvite: invite, then its three writes
      [{ id: GROUP, name: 'DBMS Study Group' }], [{ displayName: 'Rhea' }],
    );

    const result = await social.joinGroupByToken('tok', JOINER);

    expect(result).toMatchObject({ group_id: GROUP, status: 'member' });
    expect(writesTo('insert')).toEqual([groupMembers]);
  });

  it('409s for someone already in the group', async () => {
    dbMock.queueMany([group()], [membership(JOINER)]);

    await expect(social.joinGroupByToken('tok', JOINER)).rejects.toMatchObject({ statusCode: 409 });
    expect(dbMock.called('insert')).toBe(false);
  });

  it('404s for an unknown invite link', async () => {
    dbMock.queueRows([]);
    await expect(social.joinGroupByToken('nope', JOINER)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('who may review join requests', () => {
  it('lets the owner list them', async () => {
    dbMock.queueMany([group()], [joinRequest()], [joinerUser]);

    const list = await social.getJoinRequests(GROUP, OWNER);

    expect(list).toEqual([expect.objectContaining({
      id: REQUEST, user_id: JOINER, username: 'rhea', display_name: 'Rhea',
    })]);
  });

  it('lets an admin who is not the owner list them', async () => {
    dbMock.queueMany([group()], [membership(ADMIN, 'admin')], [joinRequest()], [joinerUser]);
    await expect(social.getJoinRequests(GROUP, ADMIN)).resolves.toHaveLength(1);
  });

  it('refuses an ordinary member', async () => {
    dbMock.queueMany([group()], [membership(MEMBER)]);
    await expect(social.getJoinRequests(GROUP, MEMBER)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses someone outside the group', async () => {
    dbMock.queueMany([group()], []);
    await expect(social.getJoinRequests(GROUP, JOINER)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses an ordinary member trying to approve, writing nothing', async () => {
    dbMock.queueMany([group()], [membership(MEMBER)]);

    await expect(social.approveJoinRequest(GROUP, REQUEST, MEMBER))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(dbMock.called('insert')).toBe(false);
    expect(dbMock.called('delete')).toBe(false);
  });
});

describe('approving a request', () => {
  it('adds the member and removes the request together', async () => {
    dbMock.queueMany([group()], [joinRequest()]);

    const result = await social.approveJoinRequest(GROUP, REQUEST, OWNER);

    expect(result).toEqual({ id: REQUEST, status: 'approved' });
    expect(dbMock.called('transaction')).toBe(true);
    expect(writesTo('insert')).toEqual([groupMembers]);
    expect(writesTo('delete')).toEqual([groupJoinRequests]);
  });

  it('tells the requester they are in', async () => {
    dbMock.queueMany([group()], [joinRequest()]);

    await social.approveJoinRequest(GROUP, REQUEST, OWNER);

    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: JOINER, type: 'group_request', deepLink: `/feed/groups/${GROUP}`,
    }));
  });

  it('404s for a request that is not waiting on this group', async () => {
    dbMock.queueMany([group()], []);

    await expect(social.approveJoinRequest(GROUP, REQUEST, OWNER))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(dbMock.called('insert')).toBe(false);
  });
});

describe('rejecting a request', () => {
  it('deletes it without notifying anyone', async () => {
    dbMock.queueMany([group()], [joinRequest()]); // delete ... returning

    const result = await social.rejectJoinRequest(GROUP, REQUEST, OWNER);

    expect(result).toEqual({ id: REQUEST, status: 'rejected' });
    expect(writesTo('delete')).toEqual([groupJoinRequests]);
    expect(dbMock.called('insert')).toBe(false);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('404s when there is nothing to reject', async () => {
    dbMock.queueMany([group()], []);
    await expect(social.rejectJoinRequest(GROUP, REQUEST, OWNER))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
