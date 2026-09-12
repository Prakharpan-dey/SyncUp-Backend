import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
const enqueueNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/core/queues/notification.queue.js', () => ({ enqueueNotification }));

const { SocialService } = await import('../../src/modules/social/social.service.js');
const { groupMembers, groupInvites, groupJoinRequests } = await import('../../src/core/db/schema/index.js');

const OWNER = '11111111-0000-0000-0000-000000000001';
const MEMBER = '22222222-0000-0000-0000-000000000002';
const INVITEE = '33333333-0000-0000-0000-000000000003';
const GROUP = '44444444-0000-0000-0000-000000000004';
const INVITE = '77777777-0000-0000-0000-000000000007';
const REQUEST = '66666666-0000-0000-0000-000000000006';

const group = () => ({
  id: GROUP, name: 'DBMS Study Group', ownerId: OWNER,
  isPublic: false, inviteToken: 'tok', createdAt: new Date(), updatedAt: new Date(),
});
const membership = (userId: string, role = 'member') => ({
  id: 'm-' + userId.slice(0, 2), groupId: GROUP, userId, role, joinedAt: new Date(),
});
const inviteRow = () => ({
  id: INVITE, groupId: GROUP, inviteeId: INVITEE, invitedBy: OWNER,
  createdAt: new Date('2026-09-12T08:00:00Z'),
});
const joinRequest = () => ({
  id: REQUEST, groupId: GROUP, userId: INVITEE, createdAt: new Date(),
});

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
 * Admins add people by username, email or from their friends — and the person
 * has to accept. Nobody lands in a group they did not agree to be in.
 */
describe('inviting someone', () => {
  it('sends an invite rather than adding them', async () => {
    dbMock.queueMany(
      [group()],                     // caller may manage (owner)
      [{ id: INVITEE }],             // invitee found by username
      [],                            // not already a member
      [],                            // has not asked to join
      [inviteRow()],                 // invite created
      [{ displayName: 'Owner' }],    // inviter, for the notification
    );

    const result = await social.inviteToGroup(GROUP, OWNER, { username: 'Rhea' });

    expect(result).toEqual({ status: 'invited', user_id: INVITEE });
    expect(writesTo('insert')).toEqual([groupInvites]);
    expect(writesTo('insert')).not.toContain(groupMembers);
  });

  it('tells the invitee, pointing at their invites list', async () => {
    dbMock.queueMany([group()], [{ id: INVITEE }], [], [], [inviteRow()], [{ displayName: 'Owner' }]);

    await social.inviteToGroup(GROUP, OWNER, { email: 'rhea@example.com' });

    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: INVITEE, type: 'group_invite', deepLink: '/feed/groups',
    }));
  });

  /** Email finds existing accounts only; no mail is ever sent. */
  it('404s for an email with no account, and sends nothing', async () => {
    dbMock.queueMany([group()], []);

    await expect(social.inviteToGroup(GROUP, OWNER, { email: 'nobody@example.com' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'No SyncUp account with that email' });
    expect(dbMock.called('insert')).toBe(false);
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('404s for an unknown username', async () => {
    dbMock.queueMany([group()], []);
    await expect(social.inviteToGroup(GROUP, OWNER, { username: 'ghost' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'No SyncUp account with that username' });
  });

  it('refuses inviting yourself', async () => {
    dbMock.queueMany([group()], [{ id: OWNER }]);
    await expect(social.inviteToGroup(GROUP, OWNER, { username: 'owner' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('409s for someone already in the group', async () => {
    dbMock.queueMany([group()], [{ id: INVITEE }], [membership(INVITEE)]);
    await expect(social.inviteToGroup(GROUP, OWNER, { user_id: INVITEE }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(dbMock.called('insert')).toBe(false);
  });

  /** They already asked — making them say yes a second time helps nobody. */
  it('approves a waiting join request instead of inviting', async () => {
    dbMock.queueMany(
      [group()], [{ id: INVITEE }], [], [joinRequest()], // invite path finds the request
      [group()], [joinRequest()],                        // approveJoinRequest
    );

    const result = await social.inviteToGroup(GROUP, OWNER, { user_id: INVITEE });

    expect(result).toEqual({ status: 'member', user_id: INVITEE });
    expect(writesTo('insert')).toEqual([groupMembers]);
    expect(writesTo('delete')).toEqual([groupJoinRequests]);
  });

  it('treats a repeat invite as done, without notifying again', async () => {
    dbMock.queueMany([group()], [{ id: INVITEE }], [], [], []); // insert hit the unique key

    const result = await social.inviteToGroup(GROUP, OWNER, { username: 'Rhea' });

    expect(result.status).toBe('invited');
    expect(enqueueNotification).not.toHaveBeenCalled();
  });

  it('refuses an ordinary member', async () => {
    dbMock.queueMany([group()], [membership(MEMBER)]);
    await expect(social.inviteToGroup(GROUP, MEMBER, { username: 'Rhea' }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(dbMock.called('insert')).toBe(false);
  });
});

describe('answering an invite', () => {
  it('accepting adds the member and clears the invite and any join request', async () => {
    dbMock.queueMany(
      [inviteRow()],                               // the invite is theirs
      [], [], [],                                  // insert member, delete invite, delete request
      [{ id: GROUP, name: 'DBMS Study Group' }],   // group, for the notification
      [{ displayName: 'Rhea' }],                   // invitee, for the notification
    );

    const result = await social.acceptInvite(INVITE, INVITEE);

    expect(result).toEqual({ group_id: GROUP, status: 'member' });
    expect(dbMock.called('transaction')).toBe(true);
    expect(writesTo('insert')).toEqual([groupMembers]);
    expect(writesTo('delete')).toEqual([groupInvites, groupJoinRequests]);
  });

  it('tells whoever sent the invite', async () => {
    dbMock.queueMany([inviteRow()], [], [], [], [{ id: GROUP, name: 'DBMS Study Group' }], [{ displayName: 'Rhea' }]);

    await social.acceptInvite(INVITE, INVITEE);

    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER, type: 'group_invite', deepLink: `/feed/groups/${GROUP}`,
    }));
  });

  it('404s for an invite that is not theirs, adding nobody', async () => {
    dbMock.queueRows([]);
    await expect(social.acceptInvite(INVITE, MEMBER)).rejects.toMatchObject({ statusCode: 404 });
    expect(dbMock.called('insert')).toBe(false);
  });

  it('declining deletes the invite', async () => {
    dbMock.queueRows([inviteRow()]);

    const result = await social.declineInvite(INVITE, INVITEE);

    expect(result).toEqual({ id: INVITE, status: 'declined' });
    expect(writesTo('delete')).toEqual([groupInvites]);
    expect(dbMock.called('insert')).toBe(false);
  });

  it('404s declining an invite that is not theirs', async () => {
    dbMock.queueRows([]);
    await expect(social.declineInvite(INVITE, MEMBER)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listing invites', () => {
  it('shows the invitee each group and who asked', async () => {
    dbMock.queueMany(
      [inviteRow()],
      [{ id: GROUP, name: 'DBMS Study Group' }],
      [{ id: OWNER, displayName: 'Owner' }],
    );

    const list = await social.getMyInvites(INVITEE);

    expect(list).toEqual([expect.objectContaining({
      id: INVITE, group_id: GROUP, group_name: 'DBMS Study Group', invited_by_name: 'Owner',
    })]);
  });

  it('is empty, with no further queries, when nothing is waiting', async () => {
    dbMock.queueRows([]);
    await expect(social.getMyInvites(INVITEE)).resolves.toEqual([]);
  });

  it('lets an admin cancel an invite that is still waiting', async () => {
    dbMock.queueMany([group()], [inviteRow()]);
    await expect(social.cancelInvite(GROUP, INVITE, OWNER)).resolves.toBeUndefined();
    expect(writesTo('delete')).toEqual([groupInvites]);
  });

  it('refuses a plain member cancelling', async () => {
    dbMock.queueMany([group()], [membership(MEMBER)]);
    await expect(social.cancelInvite(GROUP, INVITE, MEMBER)).rejects.toMatchObject({ statusCode: 403 });
  });
});
