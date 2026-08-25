import { db } from '../../core/db/drizzle.js';
import { friendships, users, groups, groupMembers } from '../../core/db/schema/index.js';
import { eq, and, or, inArray } from 'drizzle-orm';
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
    return userGroups.map(g => ({
      id: g.id, name: g.name, owner_id: g.ownerId, is_public: g.isPublic,
      // Only the owner gets the invite token — otherwise any member could hand
      // out permanent invites the owner never authorized.
      invite_token: g.ownerId === userId ? g.inviteToken : null,
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
    return { id: group.id, name: group.name, owner_id: group.ownerId,
      is_public: group.isPublic,
      invite_token: group.ownerId === userId ? group.inviteToken : null,
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

  async joinGroupByToken(inviteToken: string, userId: string) {
    const [group] = await db.select().from(groups).where(eq(groups.inviteToken, inviteToken)).limit(1);
    if (!group) throw new AppError(404, 'Invalid invite link', 'NOT_FOUND');

    const [existing] = await db.select().from(groupMembers)
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.userId, userId))).limit(1);
    if (existing) throw new AppError(409, 'Already a member', 'CONFLICT');

    await db.insert(groupMembers).values({ groupId: group.id, userId, role: 'member' });
    return { group_id: group.id, name: group.name };
  }

  async generateInvite(groupId: string, userId: string) {
    const inviteToken = crypto.randomBytes(16).toString('hex');
    const [updated] = await db.update(groups).set({ inviteToken, updatedAt: new Date() })
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, userId))).returning();
    if (!updated) throw new AppError(403, 'Only the owner can generate invites', 'FORBIDDEN');
    return { invite_token: updated.inviteToken };
  }

  async leaveGroup(groupId: string, userId: string) {
    await db.delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
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
