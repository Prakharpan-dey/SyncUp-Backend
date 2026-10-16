import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const enqueueEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/core/queues/email.queue.js', () => ({ enqueueEmail }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

// A mutable env so each test can decide whether a support inbox is configured.
const env: { REPORTS_EMAIL?: string } = {};
vi.mock('../../src/core/config/env.js', () => ({ env }));

const { ReportsService } = await import('../../src/modules/reports/reports.service.js');

const ME = '11111111-0000-0000-0000-000000000001';
const THEM = '22222222-0000-0000-0000-000000000002';
const OTHER = '33333333-0000-0000-0000-000000000003';
const POST = '44444444-0000-0000-0000-000000000004';

const user = (id: string, username: string) => ({ id, username, displayName: username.toUpperCase() });
const post = (userId: string) => ({
  id: POST, userId, type: 'daily_plan', title: "Shared today's plan", summary: 'Gym',
});

let service: InstanceType<typeof ReportsService>;
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  delete env.REPORTS_EMAIL;
  service = new ReportsService();
});

describe('ReportsService.create', () => {
  it('refuses a report against yourself', async () => {
    await expect(service.create(ME, { user_id: ME, reason: 'spam' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(dbMock.called('insert')).toBe(false);
  });

  it('404s for an unknown user', async () => {
    dbMock.queueRows([]);
    await expect(service.create(ME, { user_id: THEM, reason: 'spam' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('404s for a post the reporter cannot see', async () => {
    // user lookup, then the feed access check finds nothing
    dbMock.queueMany([user(THEM, 'them')], []);
    await expect(service.create(ME, { user_id: THEM, feed_item_id: POST, reason: 'harassment' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(dbMock.called('insert')).toBe(false);
  });

  it('refuses to pin a post on someone who did not write it', async () => {
    dbMock.queueMany([user(THEM, 'them')], [{ one: 1 }], [post(OTHER)]);
    await expect(service.create(ME, { user_id: THEM, feed_item_id: POST, reason: 'harassment' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(dbMock.called('insert')).toBe(false);
  });

  it('stores a post report and mails the support inbox when one is set', async () => {
    env.REPORTS_EMAIL = 'support@example.com';
    dbMock.queueMany(
      [user(THEM, 'them')], [{ one: 1 }], [post(THEM)],
      [{ id: 'r-1' }],          // insert … returning
      [user(ME, 'me')],         // reporter, for the email
    );
    const result = await service.create(ME, {
      user_id: THEM, feed_item_id: POST, reason: 'harassment', details: 'rude',
    });
    expect(result).toEqual({ id: 'r-1', status: 'open' });
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    const mail = enqueueEmail.mock.calls[0][0];
    expect(mail.to).toBe('support@example.com');
    expect(mail.subject).toContain('@them');
    expect(mail.html).toContain('rude');
  });

  it('stores but does not mail when no support inbox is set', async () => {
    dbMock.queueMany([user(THEM, 'them')], [], [{ id: 'r-2' }]);
    const result = await service.create(ME, { user_id: THEM, reason: 'spam' });
    expect(result).toEqual({ id: 'r-2', status: 'open' });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('treats a repeat person report as a no-op', async () => {
    env.REPORTS_EMAIL = 'support@example.com';
    dbMock.queueMany([user(THEM, 'them')], [{ id: 'r-old' }]);
    const result = await service.create(ME, { user_id: THEM, reason: 'spam' });
    expect(result).toEqual({ status: 'already_reported' });
    expect(dbMock.called('insert')).toBe(false);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('treats a repeat post report as a no-op', async () => {
    env.REPORTS_EMAIL = 'support@example.com';
    // the unique index swallows the insert, so returning yields no row
    dbMock.queueMany([user(THEM, 'them')], [{ one: 1 }], [post(THEM)], []);
    const result = await service.create(ME, { user_id: THEM, feed_item_id: POST, reason: 'spam' });
    expect(result).toEqual({ status: 'already_reported' });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('escapes user text in the email', async () => {
    env.REPORTS_EMAIL = 'support@example.com';
    dbMock.queueMany([user(THEM, 'them')], [], [{ id: 'r-3' }], [user(ME, 'me')]);
    await service.create(ME, { user_id: THEM, reason: 'other', details: '<script>x</script>' });
    expect(enqueueEmail.mock.calls[0][0].html).not.toContain('<script>');
  });
});
