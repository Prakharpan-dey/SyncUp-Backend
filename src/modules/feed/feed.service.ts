import { db } from '../../core/db/drizzle.js';
import { feedItems, feedReactions, users } from '../../core/db/schema/index.js';
import { eq, and, sql, type SQL } from 'drizzle-orm';
import { enqueueNotification } from '../../core/queues/notification.queue.js';
import { AppError } from '../../core/errors/app-errors.js';

/** How many plan lines travel in a feed card. */
const PLAN_ITEM_LIMIT = 10;

const PLAN_TITLE = "Shared today's plan";

/** Module-level so it can never depend on `this` if used as a callback. */
function serializePlan(row: typeof feedItems.$inferSelect) {
  return {
    id: row.id,
    actor_id: row.userId,
    actor_name: row.actorName,
    type: row.type,
    title: row.title,
    summary: row.summary,
    metadata: row.metadata,
    visibility: row.visibility,
    group_id: row.groupId,
    reaction_count: row.reactionCount,
    reacted: false,
    created_at: row.createdAt.toISOString(),
  };
}

/** A page position: the last row's exact timestamp and id. */
type FeedCursor = { at: string; id: string };

const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres `timestamp::text`, or the ISO string older builds send. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z?$/;

/**
 * Opaque to the client: base64url of the last row's exact timestamp and id.
 *
 * The cursor used to be `created_at` alone, rounded to milliseconds by
 * `toISOString()` while Postgres stores microseconds — so rows sharing a
 * millisecond (the feed worker writes a post and its group copies in one
 * statement) could be skipped between pages. Paging on (timestamp, id) at full
 * precision cannot skip or repeat a row.
 */
export function encodeFeedCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

export function decodeFeedCursor(cursor: string): FeedCursor {
  // An app still on the old build sends the bare ISO timestamp.
  if (TIMESTAMP_RE.test(cursor)) return { at: cursor, id: MAX_UUID };

  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !TIMESTAMP_RE.test(at) || !UUID_RE.test(id)) {
    throw new AppError(400, 'Invalid feed cursor', 'BAD_REQUEST');
  }
  return { at, id };
}

/** A feed row as the page query returns it. */
type FeedRow = {
  id: string;
  user_id: string;
  actor_name: string;
  actor_photo_url: string | null;
  type: string;
  title: string;
  summary: string | null;
  metadata: unknown;
  visibility: string;
  group_id: string | null;
  group_name: string | null;
  reaction_count: number;
  reacted: boolean;
  created_at_iso: string;
  created_at_raw: string;
};

/**
 * The columns a card needs, read inside the per-source scan. Never
 * `reactions` or `comments`: every page used to ship both arrays whole.
 */
const CARD_COLUMNS = sql.raw(
  'id, user_id, actor_name, actor_photo_url, type, title, summary, metadata, ' +
  'visibility, group_id, reaction_count, created_at',
);

/** Newest first. Written to match the indexes' DESC NULLS LAST exactly. */
const NEWEST_FIRST = sql.raw('created_at DESC NULLS LAST, id DESC NULLS LAST');

const afterCursor = (cursor: FeedCursor | null): SQL =>
  cursor ? sql`AND (created_at, id) < (${cursor.at}::timestamp, ${cursor.id}::uuid)` : sql``;

/** The final page, with "did I react" and both timestamp forms. */
const pageSelect = (viewerId: string, groupName: SQL): SQL => sql`
  SELECT p.id, p.user_id, p.actor_name, p.actor_photo_url, p.type, p.title,
         p.summary, p.metadata, p.visibility, p.group_id, ${groupName} AS group_name,
         p.reaction_count,
         EXISTS (
           SELECT 1 FROM feed_reactions r
           WHERE r.feed_item_id = p.id AND r.user_id = ${viewerId}
         ) AS reacted,
         to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
         p.created_at::text AS created_at_raw
`;

/**
 * One friend-feed page in one statement.
 *
 * For each friend (and yourself) it walks that person's newest posts on
 * `idx_feed_items_user_created` and stops after a page, then merges. The work
 * is bounded by friends x page size, however active or quiet they are — the old
 * `user_id IN (...) ORDER BY created_at` either walked time skipping strangers'
 * posts or gathered every friend's history and sorted it.
 */
function friendsPage(viewerId: string, cursor: FeedCursor | null, n: number): SQL {
  return sql`
    WITH sources AS (
      SELECT CASE WHEN f.requester_id = ${viewerId} THEN f.addressee_id ELSE f.requester_id END AS id
      FROM friendships f
      WHERE (f.requester_id = ${viewerId} OR f.addressee_id = ${viewerId})
        AND f.status = 'accepted'
      UNION
      SELECT ${viewerId}::uuid
    ),
    page AS (
      SELECT fi.* FROM sources
      CROSS JOIN LATERAL (
        SELECT ${CARD_COLUMNS} FROM feed_items
        WHERE user_id = sources.id AND visibility = 'friends' ${afterCursor(cursor)}
        ORDER BY ${NEWEST_FIRST}
        LIMIT ${n}
      ) fi
      ORDER BY ${NEWEST_FIRST}
      LIMIT ${n}
    )
    ${pageSelect(viewerId, sql`NULL::text`)}
    FROM page p
    ORDER BY p.created_at DESC NULLS LAST, p.id DESC NULLS LAST
  `;
}

/** One group-feed page: the same shape over your groups, names joined in. */
function groupsPage(viewerId: string, cursor: FeedCursor | null, n: number): SQL {
  return sql`
    WITH sources AS (
      SELECT gm.group_id AS id FROM group_members gm WHERE gm.user_id = ${viewerId}
    ),
    page AS (
      SELECT fi.* FROM sources
      CROSS JOIN LATERAL (
        SELECT ${CARD_COLUMNS} FROM feed_items
        WHERE group_id = sources.id AND visibility = 'group' ${afterCursor(cursor)}
        ORDER BY ${NEWEST_FIRST}
        LIMIT ${n}
      ) fi
      ORDER BY ${NEWEST_FIRST}
      LIMIT ${n}
    )
    ${pageSelect(viewerId, sql`g.name`)}
    FROM page p
    LEFT JOIN groups g ON g.id = p.group_id
    ORDER BY p.created_at DESC NULLS LAST, p.id DESC NULLS LAST
  `;
}

export class FeedService {
  /**
   * Throws 404 unless the user may see this feed item — the same rule the feed
   * uses. 404 rather than 403 so feed item ids cannot be probed for existence.
   * One query; it used to load every friend and group id first.
   */
  private async assertCanAccessItem(feedItemId: string, userId: string) {
    const rows = (await db.execute(sql`
      SELECT 1 FROM feed_items fi
      WHERE fi.id = ${feedItemId} AND (
        (fi.visibility = 'friends' AND (
          fi.user_id = ${userId} OR EXISTS (
            SELECT 1 FROM friendships f
            WHERE f.status = 'accepted' AND (
              (f.requester_id = ${userId} AND f.addressee_id = fi.user_id) OR
              (f.addressee_id = ${userId} AND f.requester_id = fi.user_id)
            )
          )
        ))
        OR (fi.visibility = 'group' AND EXISTS (
          SELECT 1 FROM group_members gm
          WHERE gm.group_id = fi.group_id AND gm.user_id = ${userId}
        ))
      )
      LIMIT 1
    `)) as unknown as unknown[];

    if (rows.length === 0) throw new AppError(404, 'Feed item not found', 'NOT_FOUND');
  }

  async getFeed(userId: string, tab: string, cursor?: string, limit = 20) {
    const after = cursor ? decodeFeedCursor(cursor) : null;
    // One extra row says whether there is another page.
    const n = limit + 1;
    const query = tab === 'friends'
      ? friendsPage(userId, after, n)
      : groupsPage(userId, after, n);

    const rows = (await db.execute(query)) as unknown as FeedRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        actor_id: row.user_id,
        actor_name: row.actor_name,
        actor_photo_url: row.actor_photo_url,
        type: row.type,
        title: row.title,
        summary: row.summary,
        metadata: row.metadata,
        visibility: row.visibility,
        group_id: row.group_id,
        group_name: row.group_name,
        reaction_count: row.reaction_count,
        // Whether this viewer has already reacted, so the client can render
        // the toggled state instead of guessing.
        reacted: row.reacted,
        created_at: row.created_at_iso,
      })),
      next_cursor: hasMore && last ? encodeFeedCursor(last.created_at_raw, last.id) : null,
    };
  }

  /**
   * One reaction per person per post: the same emoji again removes it, a
   * different one replaces it.
   *
   * A row per reaction, so this is a short transaction on one indexed row plus
   * an atomic count — it used to lock the post and rewrite its whole JSONB
   * array. The insert is ON CONFLICT DO NOTHING and the count moves only when a
   * row actually went in or out, so a double tap cannot double-count.
   */
  async react(feedItemId: string, userId: string, emoji: string) {
    await this.assertCanAccessItem(feedItemId, userId);

    const mineWhere = and(
      eq(feedReactions.feedItemId, feedItemId),
      eq(feedReactions.userId, userId),
    );

    const outcome = await db.transaction(async (tx) => {
      const [mine] = await tx
        .select({ emoji: feedReactions.emoji })
        .from(feedReactions)
        .where(mineWhere)
        .for('update')
        .limit(1);

      if (mine?.emoji === emoji) {
        const removed = await tx.delete(feedReactions).where(mineWhere)
          .returning({ userId: feedReactions.userId });
        const [item] = await tx.update(feedItems)
          .set({ reactionCount: sql`GREATEST(${feedItems.reactionCount} - ${removed.length}, 0)` })
          .where(eq(feedItems.id, feedItemId))
          .returning({ reactionCount: feedItems.reactionCount });
        return { reacted: false, count: item?.reactionCount ?? 0, isNew: false };
      }

      if (mine) {
        await tx.update(feedReactions).set({ emoji }).where(mineWhere);
        const [item] = await tx
          .select({ reactionCount: feedItems.reactionCount })
          .from(feedItems)
          .where(eq(feedItems.id, feedItemId))
          .limit(1);
        return { reacted: true, count: item?.reactionCount ?? 0, isNew: false };
      }

      const inserted = await tx.insert(feedReactions)
        .values({ feedItemId, userId, emoji })
        .onConflictDoNothing()
        .returning({ userId: feedReactions.userId });
      const [item] = await tx.update(feedItems)
        .set({ reactionCount: sql`${feedItems.reactionCount} + ${inserted.length}` })
        .where(eq(feedItems.id, feedItemId))
        .returning({ reactionCount: feedItems.reactionCount });
      return { reacted: true, count: item?.reactionCount ?? 0, isNew: inserted.length > 0 };
    });

    // Only a new reaction is worth a notification — not an undo, and not
    // swapping one emoji for another on a post already reacted to. Sent after
    // the commit, so a rolled-back reaction never notifies anyone.
    if (outcome.isNew) {
      void this.notifyOwner(feedItemId, userId, 'reaction', `reacted ${emoji} to your post`);
    }

    return { reacted: outcome.reacted, reaction_count: outcome.count };
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
  /**
   * Posts a snapshot of one day's tasks to the author's friends.
   *
   * Written straight to the table rather than through `enqueueFeedItem`, for two
   * reasons. The feed worker fans out one extra row per group the author belongs
   * to, unconditionally and with no way for a producer to opt out — routing a
   * plan through it would publish the user's whole day to every group they are
   * in. And this is an explicit action rather than a side effect, so it should
   * be synchronous and able to report back that it worked.
   *
   * Re-sharing the same day updates the existing card instead of posting a
   * second one, so a feed does not fill with one person refreshing their plan.
   */
  async shareDailyPlan(
    userId: string,
    data: { date: string; items: { title: string; done: boolean }[] },
  ) {
    const [user] = await db
      .select({
        displayName: users.displayName,
        sharing: users.privacySharingDefault,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

    // Someone who chose to share nothing should not be able to publish their
    // whole day, even deliberately. 'summary' is not filtered here: sharing a
    // plan is an explicit, previewed action and the user is looking at the exact
    // titles as they confirm.
    if (user.sharing === 'none') {
      throw new AppError(403, 'Sharing is turned off in your privacy settings', 'SHARING_DISABLED');
    }

    const total = data.items.length;
    const done = data.items.filter((i) => i.done).length;
    // Capped so one person's forty-task day cannot dominate a friend's feed or
    // bloat the jsonb column.
    const shown = data.items.slice(0, PLAN_ITEM_LIMIT);

    const metadata = {
      date: data.date,
      total,
      done,
      items: shown,
      truncated: total > shown.length,
    };
    const summary = `${done} of ${total} done`;

    const [existing] = await db
      .select({ id: feedItems.id })
      .from(feedItems)
      .where(and(
        eq(feedItems.userId, userId),
        eq(feedItems.type, 'daily_plan'),
        sql`${feedItems.metadata}->>'date' = ${data.date}`,
      ))
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(feedItems)
        .set({ actorName: user.displayName, summary, metadata })
        .where(eq(feedItems.id, existing.id))
        .returning();
      return serializePlan(updated);
    }

    const [created] = await db
      .insert(feedItems)
      .values({
        userId,
        actorName: user.displayName,
        type: 'daily_plan',
        title: PLAN_TITLE,
        summary,
        metadata,
        // Friends only, deliberately. Groups are not an audience for this.
        visibility: 'friends',
        groupId: null,
      })
      .returning();
    return serializePlan(created);
  }
}
