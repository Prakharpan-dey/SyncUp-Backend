import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

const { FeedService } = await import('../../src/modules/feed/feed.service.js');
const { SocialService } = await import('../../src/modules/social/social.service.js');

/**
 * These lock the JSON the API emits against the fixtures the Flutter DTO tests
 * parse. With the database mocked, row filtering is not verified — but the
 * *shape* is, and shape is what actually broke: five screens rendered empty
 * because the client unwrapped an envelope the API never sent, and groups
 * failed because the client read `created_by` where the API sends `owner_id`.
 *
 * Rename a field here and this fails; rename it only on the client and the
 * Flutter side fails. Either way the mismatch surfaces at test time.
 */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(__dirname, '../fixtures/api', `${name}.json`), 'utf8'),
  );

const keysOf = (o: object) => Object.keys(o).sort();

const VIEWER = 'bbbbbbbb-2222-4222-8222-222222222222';
const GROUP = 'dddddddd-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
});

describe('GET /feed item shape', () => {
  /** A row as the single page query returns it. */
  const feedRow = (over: Record<string, unknown> = {}) => ({
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    user_id: VIEWER,
    actor_name: 'Alex Dsouza',
    actor_photo_url: null,
    type: 'task_completed',
    title: 'Finish DBMS assignment',
    summary: null,
    metadata: {},
    visibility: 'friends',
    group_id: null,
    group_name: null,
    reaction_count: 2,
    reacted: true,
    created_at_iso: '2026-08-31T06:30:00.000Z',
    created_at_raw: '2026-08-31 06:30:00.000123',
    ...over,
  });

  it('emits exactly the fields the client parses', async () => {
    dbMock.queueRows([feedRow()]);

    const result = await new FeedService().getFeed(VIEWER, 'friends');
    const expected = fixture('feed_friends');

    expect(keysOf(result.items[0])).toEqual(keysOf(expected.items[0]));
    expect(result).toHaveProperty('next_cursor');
  });

  it('carries the group name on a group item so the two feeds are tellable apart', async () => {
    dbMock.queueRows([
      feedRow({
        id: 'cccccccc-3333-4333-8333-333333333333',
        title: 'Revise normalization',
        visibility: 'group',
        group_id: GROUP,
        group_name: 'DBMS Study Group',
        reaction_count: 0,
        reacted: false,
      }),
    ]);

    const result = await new FeedService().getFeed(VIEWER, 'groups');

    expect(result.items[0]).toMatchObject({
      visibility: 'group',
      group_id: GROUP,
      group_name: 'DBMS Study Group',
    });
  });

  /** Worked out in SQL now (an EXISTS on feed_reactions) and passed through. */
  it('reports whether this viewer already reacted', async () => {
    dbMock.queueRows([feedRow({ reacted: true })]);
    const mine = await new FeedService().getFeed(VIEWER, 'friends');
    expect(mine.items[0].reacted).toBe(true);

    dbMock.reset();
    dbMock.queueRows([feedRow({ reacted: false })]);
    const theirs = await new FeedService().getFeed(VIEWER, 'friends');
    expect(theirs.items[0].reacted).toBe(false);
  });

  it('no longer emits comment_count', async () => {
    dbMock.queueRows([feedRow({ reaction_count: 0, reacted: false })]);

    const result = await new FeedService().getFeed(VIEWER, 'friends');
    expect(result.items[0]).not.toHaveProperty('comment_count');
  });
});

describe('groups shapes', () => {
  // The client maps owner_id onto `createdBy`; reading `created_by` gave null
  // for a non-nullable field and threw, so creating and listing both failed.
  it('names the owner `owner_id`, and includes member_count', async () => {
    dbMock.queueMany(
      [{ groupId: GROUP }],
      [
        {
          id: GROUP,
          name: 'DBMS Study Group',
          ownerId: VIEWER,
          isPublic: false,
          inviteToken: '5f2c1ab9d4e37c60',
          createdAt: new Date('2026-08-31T06:30:00.000Z'),
        },
      ],
      [{ groupId: GROUP, total: 3 }],
    );

    const result = await new SocialService().getGroups(VIEWER);
    expect(keysOf(result[0])).toEqual(keysOf(fixture('groups_list')[0]));
    expect(result[0]).toMatchObject({ owner_id: VIEWER, member_count: 3 });
  });

  // Only the owner may see the invite token — any member could otherwise hand
  // out permanent access the owner never authorized.
  it('withholds the invite token from non-owners', async () => {
    dbMock.queueMany(
      [{ groupId: GROUP }],
      [
        {
          id: GROUP,
          name: 'DBMS Study Group',
          ownerId: 'someone-else',
          isPublic: false,
          inviteToken: 'secret',
          createdAt: new Date(),
        },
      ],
      [{ groupId: GROUP, total: 3 }],
    );

    const result = await new SocialService().getGroups(VIEWER);
    expect(result[0].invite_token).toBeNull();
  });

  it('inlines each member and can report the owner role', async () => {
    dbMock.queueMany(
      [
        { id: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: VIEWER, role: 'owner', joinedAt: new Date() },
      ],
      [{ id: VIEWER, username: 'alexdemo', displayName: 'Alex Dsouza', photoUrl: null }],
    );

    const result = await new SocialService().getGroupMembers(GROUP);
    expect(keysOf(result[0])).toEqual(keysOf(fixture('group_members')[0]));
    // `owner` is a real value here; the client enum only has admin/member, so
    // it must map rather than call byName and throw.
    expect(result[0].role).toBe('owner');
  });
});

describe('pending friend requests shape', () => {
  // The requester is inlined; there is no `receiver_id`, and no `status`.
  it('inlines the requester and matches the fixture', async () => {
    dbMock.queueMany(
      [
        {
          id: 'eeeeeeee-5555-4555-8555-555555555555',
          requesterId: 'ffffffff-6666-4666-8666-666666666666',
          addresseeId: VIEWER,
          status: 'pending',
          createdAt: new Date('2026-08-31T09:21:00.000Z'),
        },
      ],
      [
        {
          id: 'ffffffff-6666-4666-8666-666666666666',
          username: 'rhea_menon',
          displayName: 'Rhea Menon',
          photoUrl: null,
        },
      ],
    );

    const result = await new SocialService().getPendingRequests(VIEWER);
    expect(keysOf(result[0])).toEqual(keysOf(fixture('friend_requests')[0]));
  });

  it('returns a bare array, never an envelope', async () => {
    dbMock.queueRows([]);
    const result = await new SocialService().getPendingRequests(VIEWER);
    expect(Array.isArray(result)).toBe(true);
  });
});
