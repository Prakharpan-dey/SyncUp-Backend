import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const { friendshipStatusSql, UsersService } = await import('../../src/modules/users/users.service.js');

const ME = '11111111-0000-0000-0000-000000000001';

beforeEach(() => dbMock.reset());

describe('where you stand with a search result', () => {
  /**
   * The bug: the searched user's id came out without its table name, and in
   * the subquery a bare "id" is friendships.id, so every result said 'none'
   * and ADD showed even for friends.
   */
  it('ties both directions of the lookup to the searched user', () => {
    const { sql: text } = new PgDialect().sqlToQuery(friendshipStatusSql(ME));
    expect(text).toContain('f.addressee_id = "users"."id"');
    expect(text).toContain('f.requester_id = "users"."id"');
    expect(text).not.toMatch(/= "id"/);
  });

  it('passes the status through on each result', async () => {
    dbMock.queueRows([{
      user: {
        id: '22222222-0000-0000-0000-000000000002',
        username: 'rhea',
        displayName: 'Rhea',
        photoUrl: null,
        college: null,
      },
      friendshipStatus: 'requested',
    }]);

    const [result] = await new UsersService().searchUsers('rhea', ME);
    expect(result).toMatchObject({ username: 'rhea', friendship_status: 'requested' });
  });
});
