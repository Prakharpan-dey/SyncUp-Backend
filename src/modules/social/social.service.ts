import { db } from '../../core/db/drizzle.js';
import { friendships, users, groups, groupMembers, groupJoinRequests, groupInvites } from '../../core/db/schema/index.js';
import { eq, and, or, inArray, count, desc } from 'drizzle-orm';
import { enqueueNotification } from '../../core/queues/notification.queue.js';
import { AppError } from '../../core/errors/app-errors.js';
import crypto from 'crypto';

export class SocialService {
  async getFriends(userId: string) {
    const rows = await db.select().from(friendships)
      .where(and(
        or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)),
        eq(friendships.status, 'accepted'),
      ));

    const friendIds = rows.map(r => r.requesterId === userId ? r.addresseeId : r.requesterId);
    if (friendIds.length === 0) return [];

    const friendUsers = await db.select().from(users)
      .where(inArray(users.id, friendIds));
    return friendUsers.map(u => ({
      id: u.id, username: u.username, display_name: u.displayName, photo_url: u.photoUrl, college: u.college,
    }));
  }

  async getPendingRequests(userId: string) {
    const rows = await db.select().from(friendships)
      .where(and(eq(friendships.addresseeId, userId), eq(friendships.status, 'pending')));
    if (rows.length === 0) return [];

    const requesterIds = rows.map(r => r.requesterId);
    const requesters = await db.select().from(users)
      .where(inArray(users.id, requesterIds));
    return rows.map(r => {
      const u = requesters.find(u => u.id === r.requesterId);
      return {
        id: r.id, requester_id: r.requesterId,
        username: u?.username ?? '', display_name: u?.displayName ?? '',
        photo_url: u?.photoUrl ?? null, created_at: r.createdAt.toISOString(),
      };
    });
  }

  async sendFriendRequest(requesterId: string, addresseeId: string) {
    if (requesterId === addresseeId) throw new AppError(400, 'Cannot send request to yourself', 'BAD_REQUEST');

    // Without this a well-formed but unknown UUID reaches the INSERT and raises
    // a raw foreign-key violation, which the error handler maps to a 500.
    const [target] = await db.select({ id: users.id }).from(users)
      .where(eq(users.id, addresseeId)).limit(1);
    if (!target) throw new AppError(404, 'User not found', 'NOT_FOUND');

    const [existing] = await db.select().from(friendships)
      .where(or(
        and(eq(friendships.requesterId, requesterId), eq(friendships.addresseeId, addresseeId)),
        and(eq(friendships.requesterId, addresseeId), eq(friendships.addresseeId, requesterId)),
      )).limit(1);

    if (existing) {
      if (existing.status === 'blocked') throw new AppError(403, 'Cannot send request', 'FORBIDDEN');
      throw new AppError(409, 'Request already exists', 'CONFLICT');
    }

    const [request] = await db.insert(friendships).values({
      requesterId, addresseeId, status: 'pending',
    }).returning();

    void this.notifyFriendRequest(requesterId, addresseeId);

    return { id: request.id, status: request.status };
  }

  /** Fire-and-forget: a queue failure must not fail the request itself. */
  private async notifyFriendRequest(requesterId: string, addresseeId: string) {
    try {
      const [requester] = await db
        .select({ displayName: users.displayName, username: users.username })
        .from(users).where(eq(users.id, requesterId)).limit(1);
      if (!requester) return;

      await enqueueNotification({
        userId: addresseeId,
        type: 'friend_request',
        title: 'New friend request',
        body: `${requester.displayName} (@${requester.username}) wants to connect`,
        deepLink: '/feed/friends',
      });
    } catch (err) {
      console.error('[Social] Failed to enqueue friend-request notification:', err);
    }
  }

  async respondToRequest(requestId: string, userId: string, status: 'accepted' | 'blocked') {
    const [updated] = await db.update(friendships)
      .set({ status, updatedAt: new Date() })
      .where(and(
        eq(friendships.id, requestId),
        eq(friendships.addresseeId, userId),
        // Only a still-pending request can be answered. Without this, someone
        // who has been blocked is the `addressee` on the block row and could
        // flip it to 'accepted', unblocking themselves.
        eq(friendships.status, 'pending'),
      ))
      .returning();
    if (!updated) throw new AppError(404, 'Request not found', 'NOT_FOUND');
    return { id: updated.id, status: updated.status };
  }

  /**
   * Removes a block the caller created. Only the blocker can undo it — the
   * blocked party must not be able to reach this.
   */
  async unblockUser(blockedUserId: string, callerUserId: string) {
    const deleted = await db.delete(friendships).where(and(
      eq(friendships.requesterId, callerUserId),
      eq(friendships.addresseeId, blockedUserId),
      eq(friendships.status, 'blocked'),
    )).returning({ id: friendships.id });

    if (deleted.length === 0) {
      throw new AppError(404, 'No block found for this user', 'NOT_FOUND');
    }
  }

  async removeFriend(friendshipId: string, userId: string) {
    await db.delete(friendships).where(and(
      eq(friendships.id, friendshipId),
      or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)),
    ));
  }

  async getGroups(userId: string) {
    const memberships = await db.select().from(groupMembers).where(eq(groupMembers.userId, userId));
    if (memberships.length === 0) return [];
    const groupIds = memberships.map(m => m.groupId);
    const userGroups = await db.select().from(groups)
      .where(inArray(groups.id, groupIds));

    // One grouped count rather than a query per group; the client shows this on
    // every row and rendered "0 members" without it.
    const counts = await db
      .select({ groupId: groupMembers.groupId, total: count() })
      .from(groupMembers)
      .where(inArray(groupMembers.groupId, groupIds))
      .groupBy(groupMembers.groupId);
    const countByGroup = new Map(counts.map(c => [c.groupId, c.total]));

    return userGroups.map(g => ({
      id: g.id, name: g.name, owner_id: g.ownerId, is_public: g.isPublic,
      // Only the owner gets the invite token — otherwise any member could hand
      // out permanent invites the owner never authorized.
      invite_token: g.ownerId === userId ? g.inviteToken : null,
      member_count: countByGroup.get(g.id) ?? 0,
      created_at: g.createdAt.toISOString(),
    }));
  }

  async createGroup(userId: string, data: { name: string; is_public: boolean }) {
    const inviteToken = crypto.randomBytes(16).toString('hex');
    const [group] = await db.insert(groups).values({
      name: data.name, ownerId: userId, isPublic: data.is_public, inviteToken,
    }).returning();

    await db.insert(groupMembers).values({ groupId: group.id, userId, role: 'owner' });
    return { id: group.id, name: group.name, owner_id: group.ownerId,
      is_public: group.isPublic, invite_token: group.inviteToken,
      member_count: 1,
      created_at: group.createdAt.toISOString() };
  }

  async verifyMembership(groupId: string, userId: string) {
    const [membership] = await db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .limit(1);
    if (!membership) throw new AppError(403, 'You are not a member of this group', 'FORBIDDEN');
  }

  async getGroupDetail(groupId: string, userId: string) {
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
    if (!group) throw new AppError(404, 'Group not found', 'NOT_FOUND');
    const [members] = await db
      .select({ total: count() })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));

    return { id: group.id, name: group.name, owner_id: group.ownerId,
      is_public: group.isPublic,
      invite_token: group.ownerId === userId ? group.inviteToken : null,
      member_count: members?.total ?? 0,
      created_at: group.createdAt.toISOString() };
  }

  async getGroupMembers(groupId: string) {
    const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, groupId));
    if (members.length === 0) return [];
    const userIds = members.map(m => m.userId);
    const memberUsers = await db.select().from(users)
      .where(inArray(users.id, userIds));
    return members.map(m => {
      const u = memberUsers.find(u => u.id === m.userId);
      return { id: m.id, user_id: m.userId, role: m.role,
        username: u?.username ?? '', display_name: u?.displayName ?? '',
        photo_url: u?.photoUrl ?? null, joined_at: m.joinedAt.toISOString() };
    });
  }

  /**
   * Files a request to join the group behind [inviteToken].
   *
   * Opening an invite link used to admit anyone who had it, with no say for
   * the group. It now waits for an owner or admin — see approveJoinRequest.
   * Asking twice is not an error: the second call reports the request already
   * waiting, so a double tap or a reopened link reads as "pending".
   */
  async joinGroupByToken(inviteToken: string, userId: string) {
    const [group] = await db.select().from(groups).where(eq(groups.inviteToken, inviteToken)).limit(1);
    if (!group) throw new AppError(404, 'Invalid invite link', 'NOT_FOUND');

    const [existing] = await db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, userId))).limit(1);
    if (existing) throw new AppError(409, 'Already a member', 'CONFLICT');

    // Already invited: opening the code is a yes to that invite, not a
    // request an admin has to approve all over again.
    const [invite] = await db.select().from(groupInvites)
      .where(and(eq(groupInvites.groupId, group.id), eq(groupInvites.inviteeId, userId))).limit(1);
    if (invite) {
      await this.acceptInvite(invite.id, userId);
      return { group_id: group.id, name: group.name, status: 'member' };
    }

    const [created] = await db.insert(groupJoinRequests)
      .values({ groupId: group.id, userId })
      .onConflictDoNothing()
      .returning();

    // Only a new request notifies — a repeat must not ping the admins again.
    if (created) await this.notifyGroupAdmins(group, userId);

    return { group_id: group.id, name: group.name, status: 'pending' };
  }

  /**
   * The group, if [userId] may review its join requests: the owner, or a
   * member with the admin role. 404 for a missing group and 403 for anyone
   * else, decided before any request is read or changed.
   */
  private async assertCanManage(groupId: string, userId: string) {
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
    if (!group) throw new AppError(404, 'Group not found', 'NOT_FOUND');
    if (group.ownerId === userId) return group;

    const [membership] = await db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId))).limit(1);
    if (membership?.role !== 'owner' && membership?.role !== 'admin') {
      throw new AppError(403, 'Only group admins can review join requests', 'FORBIDDEN');
    }
    return group;
  }

  async getJoinRequests(groupId: string, callerUserId: string) {
    await this.assertCanManage(groupId, callerUserId);

    const requests = await db.select().from(groupJoinRequests)
      .where(eq(groupJoinRequests.groupId, groupId))
      .orderBy(groupJoinRequests.createdAt);
    if (requests.length === 0) return [];

    const requesters = await db.select().from(users)
      .where(inArray(users.id, requests.map((r) => r.userId)));
    return requests.map((r) => {
      const u = requesters.find((x) => x.id === r.userId);
      return {
        id: r.id, user_id: r.userId, username: u?.username ?? '',
        display_name: u?.displayName ?? '', photo_url: u?.photoUrl ?? null,
        created_at: r.createdAt.toISOString(),
      };
    });
  }

  async approveJoinRequest(groupId: string, requestId: string, callerUserId: string) {
    const group = await this.assertCanManage(groupId, callerUserId);

    const [request] = await db.select().from(groupJoinRequests)
      .where(and(eq(groupJoinRequests.id, requestId), eq(groupJoinRequests.groupId, groupId)))
      .limit(1);
    if (!request) throw new AppError(404, 'Request not found', 'NOT_FOUND');

    await db.transaction(async (tx) => {
      // Someone admitted another way in the meantime is simply already in,
      // which is the outcome approval wanted — not a failure.
      await tx.insert(groupMembers)
        .values({ groupId, userId: request.userId, role: 'member' })
        .onConflictDoNothing();
      await tx.delete(groupJoinRequests).where(eq(groupJoinRequests.id, requestId));
    });

    await this.notifyRequesterApproved(request.userId, group);
    return { id: requestId, status: 'approved' };
  }

  /**
   * Turns a request down by deleting it. The requester is not notified: a
   * push announcing a rejection is a harsh way to learn it, and they can ask
   * again with the link — the same as declining a friend request.
   */
  async rejectJoinRequest(groupId: string, requestId: string, callerUserId: string) {
    await this.assertCanManage(groupId, callerUserId);

    const [deleted] = await db.delete(groupJoinRequests)
      .where(and(eq(groupJoinRequests.id, requestId), eq(groupJoinRequests.groupId, groupId)))
      .returning();
    if (!deleted) throw new AppError(404, 'Request not found', 'NOT_FOUND');
    return { id: requestId, status: 'rejected' };
  }

  /** Tells everyone who can answer a join request that one is waiting. */
  private async notifyGroupAdmins(
    group: { id: string; name: string; ownerId: string },
    requesterId: string,
  ) {
    try {
      const [requester] = await db
        .select({ displayName: users.displayName, username: users.username })
        .from(users).where(eq(users.id, requesterId)).limit(1);
      if (!requester) return;

      const admins = await db.select({ userId: groupMembers.userId }).from(groupMembers)
        .where(and(
          eq(groupMembers.groupId, group.id),
          inArray(groupMembers.role, ['owner', 'admin']),
        ));
      const recipients = new Set([group.ownerId, ...admins.map((a) => a.userId)]);

      await Promise.all([...recipients].map((userId) => enqueueNotification({
        userId,
        type: 'group_request',
        title: `Request to join ${group.name}`,
        body: `${requester.displayName} (@${requester.username}) wants to join`,
        deepLink: `/feed/groups/${group.id}`,
      })));
    } catch (err) {
      console.error('[Social] Failed to enqueue group join-request notification:', err);
    }
  }

  private async notifyRequesterApproved(userId: string, group: { id: string; name: string }) {
    try {
      await enqueueNotification({
        userId,
        type: 'group_request',
        title: `You're in ${group.name}`,
        body: 'Your request to join was approved',
        deepLink: `/feed/groups/${group.id}`,
      });
    } catch (err) {
      console.error('[Social] Failed to enqueue join-approved notification:', err);
    }
  }

  /**
   * An owner or admin invites someone by username, email or — from the friend
   * picker — id. The invitee has to accept; nobody is added to a group they
   * did not agree to be in. Email finds existing accounts only; no mail is sent.
   */
  async inviteToGroup(
    groupId: string,
    callerUserId: string,
    target: { username?: string; email?: string; user_id?: string },
  ) {
    const group = await this.assertCanManage(groupId, callerUserId);

    // Username is matched exactly, capitals included — the same rule as search.
    const where = target.user_id !== undefined
      ? eq(users.id, target.user_id)
      : target.email !== undefined
        ? eq(users.email, target.email)
        : eq(users.username, target.username ?? '');
    const [invitee] = await db.select({ id: users.id }).from(users).where(where).limit(1);
    if (!invitee) {
      const how = target.email !== undefined ? 'email' : 'username';
      throw new AppError(404, `No SyncUp account with that ${how}`, 'NOT_FOUND');
    }
    if (invitee.id === callerUserId) {
      throw new AppError(400, 'You are already in this group', 'BAD_REQUEST');
    }

    const [member] = await db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, invitee.id))).limit(1);
    if (member) throw new AppError(409, 'Already a member', 'CONFLICT');

    // They already asked to join; an invite would make them say yes twice.
    const [asked] = await db.select().from(groupJoinRequests)
      .where(and(eq(groupJoinRequests.groupId, groupId), eq(groupJoinRequests.userId, invitee.id)))
      .limit(1);
    if (asked) {
      await this.approveJoinRequest(groupId, asked.id, callerUserId);
      return { status: 'member', user_id: invitee.id };
    }

    const [created] = await db.insert(groupInvites)
      .values({ groupId, inviteeId: invitee.id, invitedBy: callerUserId })
      .onConflictDoNothing()
      .returning();
    // A repeat invite is not an error, but must not notify again.
    if (created) await this.notifyInvitee(invitee.id, group, callerUserId);
    return { status: 'invited', user_id: invitee.id };
  }

  /** Invites waiting on [userId], newest first, with enough to show who asked. */
  async getMyInvites(userId: string) {
    const invites = await db.select().from(groupInvites)
      .where(eq(groupInvites.inviteeId, userId))
      .orderBy(desc(groupInvites.createdAt));
    if (invites.length === 0) return [];

    const groupRows = await db.select({ id: groups.id, name: groups.name }).from(groups)
      .where(inArray(groups.id, invites.map((i) => i.groupId)));
    const inviterIds = invites
      .map((i) => i.invitedBy)
      .filter((id): id is string => id !== null);
    const inviters = inviterIds.length === 0
      ? []
      : await db.select({ id: users.id, displayName: users.displayName }).from(users)
        .where(inArray(users.id, inviterIds));

    return invites.map((i) => ({
      id: i.id,
      group_id: i.groupId,
      group_name: groupRows.find((g) => g.id === i.groupId)?.name ?? '',
      invited_by_name: inviters.find((u) => u.id === i.invitedBy)?.displayName ?? null,
      created_at: i.createdAt.toISOString(),
    }));
  }

  async acceptInvite(inviteId: string, userId: string) {
    const [invite] = await db.select().from(groupInvites)
      .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.inviteeId, userId)))
      .limit(1);
    if (!invite) throw new AppError(404, 'Invite not found', 'NOT_FOUND');

    await db.transaction(async (tx) => {
      await tx.insert(groupMembers)
        .values({ groupId: invite.groupId, userId, role: 'member' })
        .onConflictDoNothing();
      await tx.delete(groupInvites).where(eq(groupInvites.id, inviteId));
      // A join request of their own is answered by this too.
      await tx.delete(groupJoinRequests).where(and(
        eq(groupJoinRequests.groupId, invite.groupId),
        eq(groupJoinRequests.userId, userId),
      ));
    });

    const [group] = await db.select({ id: groups.id, name: groups.name }).from(groups)
      .where(eq(groups.id, invite.groupId)).limit(1);
    if (invite.invitedBy && group) {
      await this.notifyInviteAccepted(invite.invitedBy, userId, group);
    }
    return { group_id: invite.groupId, status: 'member' };
  }

  async declineInvite(inviteId: string, userId: string) {
    const [deleted] = await db.delete(groupInvites)
      .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.inviteeId, userId)))
      .returning();
    if (!deleted) throw new AppError(404, 'Invite not found', 'NOT_FOUND');
    return { id: inviteId, status: 'declined' };
  }

  /** Invites an owner or admin has sent that nobody has answered yet. */
  async getGroupInvites(groupId: string, callerUserId: string) {
    await this.assertCanManage(groupId, callerUserId);

    const invites = await db.select().from(groupInvites)
      .where(eq(groupInvites.groupId, groupId))
      .orderBy(groupInvites.createdAt);
    if (invites.length === 0) return [];

    const invitees = await db.select().from(users)
      .where(inArray(users.id, invites.map((i) => i.inviteeId)));
    return invites.map((i) => {
      const u = invitees.find((x) => x.id === i.inviteeId);
      return {
        id: i.id, user_id: i.inviteeId, username: u?.username ?? '',
        display_name: u?.displayName ?? '', photo_url: u?.photoUrl ?? null,
        created_at: i.createdAt.toISOString(),
      };
    });
  }

  async cancelInvite(groupId: string, inviteId: string, callerUserId: string) {
    await this.assertCanManage(groupId, callerUserId);
    const [deleted] = await db.delete(groupInvites)
      .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.groupId, groupId)))
      .returning();
    if (!deleted) throw new AppError(404, 'Invite not found', 'NOT_FOUND');
  }

  private async notifyInvitee(
    inviteeId: string,
    group: { id: string; name: string },
    inviterId: string,
  ) {
    try {
      const [inviter] = await db.select({ displayName: users.displayName }).from(users)
        .where(eq(users.id, inviterId)).limit(1);
      await enqueueNotification({
        userId: inviteeId,
        type: 'group_invite',
        title: `Invite to ${group.name}`,
        body: `${inviter?.displayName ?? 'Someone'} invited you to join`,
        // The invites list lives on the groups screen; the group itself is
        // not visible to them until they accept.
        deepLink: '/feed/groups',
      });
    } catch (err) {
      console.error('[Social] Failed to enqueue group invite notification:', err);
    }
  }

  private async notifyInviteAccepted(
    inviterId: string,
    inviteeId: string,
    group: { id: string; name: string },
  ) {
    try {
      const [invitee] = await db.select({ displayName: users.displayName }).from(users)
        .where(eq(users.id, inviteeId)).limit(1);
      await enqueueNotification({
        userId: inviterId,
        type: 'group_invite',
        title: `${invitee?.displayName ?? 'Someone'} joined ${group.name}`,
        body: 'They accepted your invite',
        deepLink: `/feed/groups/${group.id}`,
      });
    } catch (err) {
      console.error('[Social] Failed to enqueue invite-accepted notification:', err);
    }
  }

  async generateInvite(groupId: string, userId: string) {
    const inviteToken = crypto.randomBytes(16).toString('hex');
    const [updated] = await db.update(groups).set({ inviteToken, updatedAt: new Date() })
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, userId))).returning();
    if (!updated) throw new AppError(403, 'Only the owner can generate invites', 'FORBIDDEN');
    return { invite_token: updated.inviteToken };
  }

  /**
   * Removes the caller from a group they belong to.
   *
   * Nothing called this before — the only DELETE route went to removeMember,
   * which rejects a non-owner outright and refuses an owner removing
   * themselves, so leaving a group was impossible for everyone in it while the
   * app still offered a LEAVE GROUP button.
   *
   * When the owner leaves, the group is handed to its longest-tenured
   * remaining member, matching what account deletion already does. Otherwise
   * the group would survive with an owner who is not in it: nobody could
   * invite, and nobody could remove.
   */
  async leaveGroup(groupId: string, userId: string) {
    const [group] = await db.select().from(groups)
      .where(eq(groups.id, groupId)).limit(1);
    // 404 rather than 403 for a non-member: a stranger probing group ids should
    // not be able to tell an existing group from one that does not exist.
    if (!group) throw new AppError(404, 'Group not found', 'NOT_FOUND');

    const [membership] = await db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .limit(1);
    if (!membership) throw new AppError(404, 'Group not found', 'NOT_FOUND');

    await db.transaction(async (tx) => {
      await tx.delete(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));

      if (group.ownerId !== userId) return;

      const [successor] = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, groupId))
        .orderBy(groupMembers.joinedAt)
        .limit(1);

      if (!successor) {
        await tx.delete(groups).where(eq(groups.id, groupId));
        return;
      }

      await tx.update(groups)
        .set({ ownerId: successor.userId, updatedAt: new Date() })
        .where(eq(groups.id, groupId));
      await tx.update(groupMembers)
        .set({ role: 'owner' })
        .where(and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, successor.userId),
        ));
    });
  }

  async removeMember(groupId: string, memberId: string, callerUserId: string) {
    const [group] = await db.select().from(groups)
      .where(eq(groups.id, groupId)).limit(1);
    if (!group) throw new AppError(404, 'Group not found', 'NOT_FOUND');
    if (group.ownerId !== callerUserId) throw new AppError(403, 'Only the group owner can remove members', 'FORBIDDEN');
    if (memberId === callerUserId) throw new AppError(400, 'Cannot remove yourself; use leave instead', 'BAD_REQUEST');

    await db.delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, memberId)));
  }
}
