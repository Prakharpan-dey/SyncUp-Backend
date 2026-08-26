import { db } from '../../core/db/drizzle.js';
import { users, friendships } from '../../core/db/schema/index.js';
import { eq, and, or, ilike, ne } from 'drizzle-orm';
import { AppError } from '../../core/errors/app-errors.js';

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

  async searchUsers(query: string, currentUserId: string) {
    // Escape LIKE metacharacters so a query of '%' cannot match every user and
    // page through the entire searchable directory.
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);

    const results = await db
      .select()
      .from(users)
      .where(
        and(
          ne(users.id, currentUserId),
          or(
            ilike(users.username, `%${escaped}%`),
            ilike(users.displayName, `%${escaped}%`),
          ),
          // Only show users with privacy_searchable = 'everyone'
          // TODO: Add 'friends' check when friendship lookup is available
          eq(users.privacySearchable, 'everyone'),
        ),
      )
      .limit(20);

    return results.map((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.displayName,
      photo_url: u.photoUrl,
      college: u.college,
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

    // Remove any existing friendship, insert block
    await db
      .delete(friendships)
      .where(
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
}
