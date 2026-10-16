import { db } from '../../core/db/drizzle.js';
import {
  users, friendships, tasks, subjects, attendanceSessions,
  groups, groupMembers, feedItems, notifications, userDevices,
} from '../../core/db/schema/index.js';
import { eq, and, or, ne, exists, notExists, sql } from 'drizzle-orm';
import { AppError } from '../../core/errors/app-errors.js';

/**
 * Where `currentUserId` stands with the `users` row being selected:
 * 'friends', 'requested' (you asked), 'incoming' (they asked) or 'none'.
 *
 * The searched user's id is written out as "users"."id" rather than
 * interpolated as a column. Interpolated, it came out without its table name,
 * and inside this subquery a bare "id" is friendships.id — so the lookup never
 * matched anyone and every result said 'none'.
 */
export function friendshipStatusSql(currentUserId: string) {
  return sql<string>`COALESCE((
    SELECT CASE
      WHEN f.status = 'accepted' THEN 'friends'
      WHEN f.requester_id = ${currentUserId} THEN 'requested'
      ELSE 'incoming'
    END
    FROM friendships f
    WHERE f.status IN ('accepted', 'pending') AND (
      (f.requester_id = ${currentUserId} AND f.addressee_id = "users"."id") OR
      (f.addressee_id = ${currentUserId} AND f.requester_id = "users"."id")
    )
    LIMIT 1
  ), 'none')`;
}

export class UsersService {
  async getProfile(userId: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
    return this.sanitize(user);
  }

  async updateProfile(userId: string, fields: Record<string, unknown>) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (fields.display_name) updateData.displayName = fields.display_name;
    if (fields.college !== undefined) updateData.college = fields.college;
    if (fields.department !== undefined) updateData.department = fields.department;
    if (fields.semester !== undefined) updateData.semester = fields.semester;
    if (fields.graduation_year !== undefined) updateData.graduationYear = fields.graduation_year;
    if (fields.privacy_searchable) updateData.privacySearchable = fields.privacy_searchable;
    if (fields.privacy_sharing_default) updateData.privacySharingDefault = fields.privacy_sharing_default;
    if (fields.notification_settings) updateData.notificationSettings = fields.notification_settings;

    const [updated] = await db
      .update(users)
      .set(updateData)
      .where(eq(users.id, userId))
      .returning();

    if (!updated) throw new AppError(404, 'User not found', 'NOT_FOUND');
    return this.sanitize(updated);
  }

  /// Looks up a single user by their exact username.
  ///
  /// Deliberately not a directory search. SyncUp is a study tool, not a social
  /// network: you add someone because you already know their handle. Matching
  /// substrings of usernames and display names let anyone page through the
  /// whole user base a few characters at a time, which is a privacy problem
  /// with no upside here.
  ///
  /// Matching is exact, capitals included: `Sakshi` does not find `@sakshi`.
  /// Uniqueness stays case-insensitive (uq_users_username_lower), so two
  /// accounts can never differ only by case and nobody can register a
  /// lookalike of someone else's handle.
  async searchUsers(query: string, currentUserId: string) {
    const handle = query.trim();
    if (handle.length === 0) return [];

    // Correlated on users.id, so it is evaluated for the candidate row rather
    // than needing the caller's whole friend list up front.
    const isFriendOfCaller = exists(
      db
        .select({ one: sql`1` })
        .from(friendships)
        .where(
          and(
            eq(friendships.status, 'accepted'),
            // Either side may have sent the request.
            or(
              and(
                eq(friendships.requesterId, currentUserId),
                eq(friendships.addresseeId, users.id),
              ),
              and(
                eq(friendships.addresseeId, currentUserId),
                eq(friendships.requesterId, users.id),
              ),
            ),
          ),
        ),
    );

    // A block hides the pair from each other in both directions: the blocker
    // should not have to keep seeing them, and the blocked party must not be
    // able to find the blocker to try again under a new request.
    const notBlockedEitherWay = notExists(
      db
        .select({ one: sql`1` })
        .from(friendships)
        .where(
          and(
            eq(friendships.status, 'blocked'),
            or(
              and(
                eq(friendships.requesterId, currentUserId),
                eq(friendships.addresseeId, users.id),
              ),
              and(
                eq(friendships.addresseeId, currentUserId),
                eq(friendships.requesterId, users.id),
              ),
            ),
          ),
        ),
    );

    const friendshipStatus = friendshipStatusSql(currentUserId);

    const results = await db
      .select({ user: users, friendshipStatus })
      .from(users)
      .where(
        and(
          ne(users.id, currentUserId),
          eq(users.username, handle),
          notBlockedEitherWay,
          // 'friends' used to fall through this filter and behave exactly like
          // 'none', so anyone who picked "Friends only" became invisible to
          // their own friends with nothing to indicate it.
          or(
            eq(users.privacySearchable, 'everyone'),
            and(eq(users.privacySearchable, 'friends'), isFriendOfCaller),
          ),
        ),
      )
      .limit(1);

    return results.map(({ user: u, friendshipStatus: status }) => ({
      id: u.id,
      username: u.username,
      display_name: u.displayName,
      photo_url: u.photoUrl,
      college: u.college,
      // 'friends' | 'requested' (you asked) | 'incoming' (they asked) | 'none'
      friendship_status: status,
    }));
  }

  async blockUser(currentUserId: string, targetUserId: string) {
    if (currentUserId === targetUserId) {
      throw new AppError(400, 'Cannot block yourself', 'BAD_REQUEST');
    }

    // Without this a well-formed but unknown UUID reaches the INSERT and
    // raises a raw foreign-key violation, which the error handler maps to 500.
    const [target] = await db.select({ id: users.id }).from(users)
      .where(eq(users.id, targetUserId)).limit(1);
    if (!target) throw new AppError(404, 'User not found', 'NOT_FOUND');

    // Check if already blocked
    const [existing] = await db
      .select()
      .from(friendships)
      .where(
        and(
          eq(friendships.requesterId, currentUserId),
          eq(friendships.addresseeId, targetUserId),
          eq(friendships.status, 'blocked'),
        ),
      )
      .limit(1);

    if (existing) return; // Already blocked

    // Remove any friendship or pending request, then insert the block. Their
    // own block of us, if they made one, stays: deleting it here would let
    // anyone lift a block against them by blocking back and then unblocking.
    await db
      .delete(friendships)
      .where(
        and(
          ne(friendships.status, 'blocked'),
          or(
            and(
              eq(friendships.requesterId, currentUserId),
              eq(friendships.addresseeId, targetUserId),
            ),
            and(
              eq(friendships.requesterId, targetUserId),
              eq(friendships.addresseeId, currentUserId),
            ),
          ),
        ),
      );

    await db.insert(friendships).values({
      requesterId: currentUserId,
      addresseeId: targetUserId,
      status: 'blocked',
    });
  }

  private sanitize(user: typeof users.$inferSelect) {
    const { passwordHash, ...safe } = user;
    return {
      id: safe.id,
      username: safe.username,
      display_name: safe.displayName,
      email: safe.email,
      email_verified_at: safe.emailVerifiedAt?.toISOString() ?? null,
      photo_url: safe.photoUrl,
      college: safe.college,
      department: safe.department,
      semester: safe.semester,
      graduation_year: safe.graduationYear,
      privacy_searchable: safe.privacySearchable,
      privacy_sharing_default: safe.privacySharingDefault,
      notification_settings: safe.notificationSettings,
      created_at: safe.createdAt.toISOString(),
      updated_at: safe.updatedAt.toISOString(),
    };
  }

  /**
   * Everything this account owns, as one JSON document.
   *
   * Deliberately scoped to the user's own rows. Their friendships and group
   * memberships name other people, so those carry ids and the group's name
   * only — never another user's email, or anything they have not already been
   * shown in the app.
   *
   * Sessions and auth tokens are excluded on purpose: exporting refresh token
   * hashes and reset tokens would put live credentials in a file people email
   * to themselves.
   */
  async exportData(userId: string) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

    const [
      ownTasks, ownSubjects, ownSessions, ownFeed,
      ownNotifications, ownDevices, ownFriendships, memberships,
    ] = await Promise.all([
      db.select().from(tasks).where(eq(tasks.userId, userId)),
      db.select().from(subjects).where(eq(subjects.userId, userId)),
      // Sessions hang off a subject, not a user, so they are reached through
      // the caller's own subjects.
      db.select({
        id: attendanceSessions.id,
        subjectId: attendanceSessions.subjectId,
        subjectName: subjects.name,
        sessionDate: attendanceSessions.sessionDate,
        status: attendanceSessions.status,
        createdAt: attendanceSessions.createdAt,
      }).from(attendanceSessions)
        .innerJoin(subjects, eq(subjects.id, attendanceSessions.subjectId))
        .where(eq(subjects.userId, userId)),
      db.select().from(feedItems).where(eq(feedItems.userId, userId)),
      db.select().from(notifications).where(eq(notifications.userId, userId)),
      db.select({
        platform: userDevices.platform,
        createdAt: userDevices.createdAt,
        lastSeenAt: userDevices.lastSeenAt,
      }).from(userDevices).where(eq(userDevices.userId, userId)),
      db.select().from(friendships).where(
        or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))),
      db.select({
        groupId: groupMembers.groupId,
        role: groupMembers.role,
        joinedAt: groupMembers.joinedAt,
        groupName: groups.name,
      }).from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(eq(groupMembers.userId, userId)),
    ]);

    return {
      exported_at: new Date().toISOString(),
      profile: this.sanitize(user),
      tasks: ownTasks,
      subjects: ownSubjects,
      attendance_sessions: ownSessions,
      feed_items: ownFeed,
      notifications: ownNotifications,
      // Push tokens themselves are omitted; they identify a handset and are
      // useless to the user.
      devices: ownDevices,
      friendships: ownFriendships.map((f) => ({
        friend_id: f.requesterId === userId ? f.addresseeId : f.requesterId,
        direction: f.requesterId === userId ? 'sent' : 'received',
        status: f.status,
        created_at: f.createdAt,
      })),
      group_memberships: memberships,
    };
  }
}
