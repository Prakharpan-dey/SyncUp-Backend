import { db } from '../../core/db/drizzle.js';
import { feedItems, reports, users } from '../../core/db/schema/index.js';
import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '../../core/errors/app-errors.js';
import { env } from '../../core/config/env.js';
import { enqueueEmail } from '../../core/queues/email.queue.js';
import { reportFiledEmail } from '../auth/emails/templates.js';
import { FeedService } from '../feed/feed.service.js';
import type { CreateReportInput } from './reports.schema.js';

const feed = new FeedService();

export class ReportsService {
  /**
   * Files a report and mails it to the support inbox.
   *
   * A post can only be reported by someone allowed to see it (404 otherwise,
   * like the feed), and only against the person who posted it, so a report
   * cannot pin someone else's post on an unrelated user.
   */
  async create(reporterId: string, input: CreateReportInput) {
    if (input.user_id === reporterId) {
      throw new AppError(400, 'You cannot report yourself', 'BAD_REQUEST');
    }

    const [reported] = await db.select().from(users).where(eq(users.id, input.user_id)).limit(1);
    if (!reported) throw new AppError(404, 'User not found', 'NOT_FOUND');

    let post: typeof feedItems.$inferSelect | undefined;
    if (input.feed_item_id) {
      await feed.assertCanAccessItem(input.feed_item_id, reporterId);
      [post] = await db.select().from(feedItems).where(eq(feedItems.id, input.feed_item_id)).limit(1);
      if (!post) throw new AppError(404, 'Feed item not found', 'NOT_FOUND');
      if (post.userId !== input.user_id) {
        throw new AppError(400, 'That post is not by this user', 'BAD_REQUEST');
      }
    }

    // Post reports are deduped by a unique index; person reports by this check
    // (see the schema for why they have no index).
    if (!input.feed_item_id) {
      const [existing] = await db.select({ id: reports.id }).from(reports).where(and(
        eq(reports.reporterId, reporterId),
        eq(reports.reportedUserId, input.user_id),
        isNull(reports.feedItemId),
      )).limit(1);
      if (existing) return { status: 'already_reported' as const };
    }

    const details = input.details ? input.details : null;
    const [created] = await db.insert(reports).values({
      reporterId,
      reportedUserId: input.user_id,
      feedItemId: input.feed_item_id ?? null,
      reason: input.reason,
      details,
    }).onConflictDoNothing().returning({ id: reports.id });

    // Already reported: say so quietly rather than mail the inbox again.
    if (!created) return { status: 'already_reported' as const };

    if (env.REPORTS_EMAIL) {
      const [reporter] = await db.select().from(users).where(eq(users.id, reporterId)).limit(1);
      const mail = reportFiledEmail({
        reportId: created.id,
        reason: input.reason,
        details,
        reporter: { id: reporterId, username: reporter?.username ?? 'unknown' },
        reported: { id: reported.id, username: reported.username, displayName: reported.displayName },
        post: post ? { type: post.type, title: post.title, summary: post.summary } : null,
      });
      await enqueueEmail({ to: env.REPORTS_EMAIL, ...mail });
    }

    return { id: created.id, status: 'open' as const };
  }
}
