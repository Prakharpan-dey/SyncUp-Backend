import { db } from '../../core/db/drizzle.js';
import { feedItems, friendships, groupMembers, users } from '../../core/db/schema/index.js';
import { eq, and, or, lt, desc, inArray, sql } from 'drizzle-orm';
import { enqueueNotification } from '../../core/queues/notification.queue.js';
import { AppError } from '../../core/errors/app-errors.js';

export class FeedService {
  /** User IDs whose 'friends'-visibility items this user may see (accepted friends + self). */
  private async visibleFriendIds(userId: string) {
    const rows = await db.select().from(friendships)
      .where(and(
        or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId)),
        eq(friendships.status, 'accepted'),
      ));
    return [
      ...rows.map(r => r.requesterId === userId ? r.addresseeId : r.requesterId),
      userId,
    ];
  }

  /** Group IDs this user belongs to. */
  private async memberGroupIds(userId: string) {
    const memberships = await db.select().from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    return memberships.map(m => m.groupId);
  }

  /**
   * Throws 404 unless the user may see this feed item — same predicate getFeed
   * uses. 404 rather than 403 so feed item IDs cannot be probed for existence.
   */
  private async assertCanAccessItem(feedItemId: string, userId: string) {
    const [item] = await db.select({
      userId: feedItems.userId,
      visibility: feedItems.visibility,
      groupId: feedItems.groupId,
    }).from(feedItems).where(eq(feedItems.id, feedItemId)).limit(1);

    if (!item) throw new AppError(404, 'Feed item not found', 'NOT_FOUND');

    const visible = item.visibility === 'friends'
      ? (await this.visibleFriendIds(userId)).includes(item.userId)
      : item.groupId !== null && (await this.memberGroupIds(userId)).includes(item.groupId);

    if (!visible) throw new AppError(404, 'Feed item not found', 'NOT_FOUND');
  }

  async getFeed(userId: string, tab: string, cursor?: string, limit = 20) {
    const conditions = [];

    if (tab === 'friends') {
      conditions.push(eq(feedItems.visibility, 'friends'));
      conditions.push(inArray(feedItems.userId, await this.visibleFriendIds(userId)));
    } else {
      const groupIds = await this.memberGroupIds(userId);
      if (groupIds.length === 0) return { items: [], next_cursor: null };

      conditions.push(eq(feedItems.visibility, 'group'));
      conditions.push(inArray(feedItems.groupId, groupIds));
    }

    if (cursor) {
      conditions.push(lt(feedItems.createdAt, new Date(cursor)));
    }

    const items = await db.select().from(feedItems)
      .where(and(...conditions))
      .orderBy(desc(feedItems.createdAt))
      .limit(limit + 1);

    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? pageItems[pageItems.length - 1].createdAt.toISOString() : null;

    return {
      items: pageItems.map(item => ({
        id: item.id,
        actor_id: item.userId,
        actor_name: item.actorName,
        actor_photo_url: item.actorPhotoUrl,
        type: item.type,
        title: item.title,
        summary: item.summary,
        metadata: item.metadata,
        visibility: item.visibility,
        group_id: item.groupId,
        reaction_count: item.reactionCount,
        comment_count: item.commentCount,
        created_at: item.createdAt.toISOString(),
      })),
      next_cursor: nextCursor,
    };
  }

  async react(feedItemId: string, userId: string, emoji: string) {
    await this.assertCanAccessItem(feedItemId, userId);

    const reaction = JSON.stringify([{ user_id: userId, emoji, created_at: new Date().toISOString() }]);
    const result = await db.update(feedItems).set({
      reactions: sql`coalesce(${feedItems.reactions}, '[]'::jsonb) || ${reaction}::jsonb`,
      reactionCount: sql`${feedItems.reactionCount} + 1`,
    }).where(eq(feedItems.id, feedItemId)).returning({ id: feedItems.id });

    if (result.length === 0) throw new AppError(404, 'Feed item not found', 'NOT_FOUND');

    void this.notifyOwner(feedItemId, userId, 'reaction', `reacted ${emoji} to your post`);
  }

  async comment(feedItemId: string, userId: string, text: string) {
    await this.assertCanAccessItem(feedItemId, userId);

    const comment = JSON.stringify([{ user_id: userId, text, created_at: new Date().toISOString() }]);
    const result = await db.update(feedItems).set({
      comments: sql`coalesce(${feedItems.comments}, '[]'::jsonb) || ${comment}::jsonb`,
      commentCount: sql`${feedItems.commentCount} + 1`,
    }).where(eq(feedItems.id, feedItemId)).returning({ id: feedItems.id });

    if (result.length === 0) throw new AppError(404, 'Feed item not found', 'NOT_FOUND');

    void this.notifyOwner(feedItemId, userId, 'comment', 'commented on your post');
  }

  /**
   * Tells the item's owner someone interacted with it.
   *
   * Skipped when they are interacting with their own post. Fire-and-forget — a
   * queue failure must not fail the reaction the user just made.
   */
  private async notifyOwner(
    feedItemId: string,
    actorId: string,
    type: 'reaction' | 'comment',
    action: string,
  ) {
    try {
      const [item] = await db
        .select({ ownerId: feedItems.userId })
        .from(feedItems).where(eq(feedItems.id, feedItemId)).limit(1);
      if (!item || item.ownerId === actorId) return;

      const [actor] = await db
        .select({ displayName: users.displayName })
        .from(users).where(eq(users.id, actorId)).limit(1);
      if (!actor) return;

      await enqueueNotification({
        userId: item.ownerId,
        type,
        title: actor.displayName,
        body: `${actor.displayName} ${action}`,
        deepLink: '/feed',
      });
    } catch (err) {
      console.error('[Feed] Failed to enqueue interaction notification:', err);
    }
  }
}
