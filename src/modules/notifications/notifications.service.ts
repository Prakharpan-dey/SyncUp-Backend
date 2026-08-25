import { db } from '../../core/db/drizzle.js';
import { notifications } from '../../core/db/schema/index.js';
import { eq, and, desc, count } from 'drizzle-orm';
import { AppError } from '../../core/errors/app-errors.js';

export class NotificationsService {
  async list(userId: string) {
    const items = await db.select().from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    return items.map(n => ({
      id: n.id, user_id: n.userId, type: n.type, title: n.title,
      body: n.body, metadata: n.metadata, is_read: n.isRead,
      deep_link: n.deepLink, created_at: n.createdAt.toISOString(),
    }));
  }

  async markAsRead(notificationId: string, userId: string) {
    const [updated] = await db.update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
      .returning();
    if (!updated) throw new AppError(404, 'Notification not found', 'NOT_FOUND');
  }

  async markAllAsRead(userId: string) {
    await db.update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
  }

  async getUnreadCount(userId: string) {
    const [result] = await db.select({ count: count() }).from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
    return { count: result?.count ?? 0 };
  }
}
