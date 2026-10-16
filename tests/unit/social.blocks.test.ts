import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { SocialService } = await import('../../src/modules/social/social.service.js');
const { UsersService } = await import('../../src/modules/users/users.service.js');
const { FeedService } = await import('../../src/modules/feed/feed.service.js');

const ME = '11111111-0000-0000-0000-000000000001';
const THEM = '22222222-0000-0000-0000-000000000002';

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL).sql;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
});

describe('SocialService.listBlocked', () => {
  it('returns the people the caller blocked, in the app shape', async () => {
    const at = new Date('2026-10-16T10:00:00Z');
    dbMock.queueRows([{
      user: { id: THEM, username: 'them', displayName: 'Them', photoUrl: null },
      blockedAt: at,
    }]);
    const list = await new SocialService().listBlocked(ME);
    expect(list).toEqual([{
      id: THEM, username: 'them', display_name: 'Them', photo_url: null,
      blocked_at: at.toISOString(),
    }]);
  });
});

describe('UsersService.blockUser', () => {
  /**
   * Blocking someone who had already blocked you used to delete their block
   * along with the friendship, so blocking back and then unblocking lifted a
   * block you were never meant to be able to touch.
   */
  it('leaves the other side\'s block in place', async () => {
    dbMock.queueMany([{ id: THEM }], []);
    await new UsersService().blockUser(ME, THEM);

    const del = dbMock.trace.findIndex((c) => c.method === 'delete');
    const where = dbMock.trace.slice(del).find((c) => c.method === 'where');
    expect(render(where!.args[0])).toMatch(/"status" <> \$\d/);
    expect(dbMock.called('insert')).toBe(true);
  });
});

describe('the group feed', () => {
  it('hides posts from anyone blocked in either direction', async () => {
    dbMock.queueRows([]);
    await new FeedService().getFeed(ME, 'groups');
    const query = render(dbMock.trace.find((c) => c.method === 'execute')!.args[0]);
    expect(query).toContain("b.status = 'blocked'");
    expect(query).toMatch(/b\.requester_id = \$\d+ AND b\.addressee_id = feed_items\.user_id/);
    expect(query).toMatch(/b\.addressee_id = \$\d+ AND b\.requester_id = feed_items\.user_id/);
  });
});
