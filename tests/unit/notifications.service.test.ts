import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));

const { NotificationsService } = await import(
  '../../src/modules/notifications/notifications.service.js'
);

const service = new NotificationsService();

beforeEach(() => dbMock.reset());

/** The app could only mark notifications read, so a cleared one came back. */
describe('clearing notifications', () => {
  it('deletes one of your own', async () => {
    dbMock.queueRows([{ id: 'n1' }]);

    await expect(service.remove('n1', 'u1')).resolves.toBeUndefined();
    expect(dbMock.called('delete')).toBe(true);
  });

  it('answers not found for an id that is not yours', async () => {
    dbMock.queueRows([]);

    await expect(service.remove('n1', 'someone-else')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('clears the whole inbox', async () => {
    dbMock.queueRows([]);

    await expect(service.clear('u1')).resolves.toBeUndefined();
    expect(dbMock.called('delete')).toBe(true);
    expect(dbMock.called('where')).toBe(true);
  });
});
