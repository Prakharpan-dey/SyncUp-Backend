import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/middleware/auth.middleware.js', () => ({
  invalidateAccountCache: vi.fn().mockResolvedValue(undefined),
}));

const { AuthService } = await import('../../src/modules/auth/auth.service.js');

const USER = '11111111-0000-0000-0000-000000000001';
const SESSION = '22222222-0000-0000-0000-000000000002';
const TOKEN_ROW_ID = '33333333-0000-0000-0000-000000000003';

const future = () => new Date(Date.now() + 30 * 24 * 3600_000);
const past = () => new Date(Date.now() - 1000);

/** A stored refresh token row, live unless overridden. */
const storedToken = (over: Record<string, unknown> = {}) => ({
  id: TOKEN_ROW_ID,
  userId: USER,
  tokenHash: 'hash',
  sessionId: SESSION,
  deviceLabel: 'Pixel 8 Pro · Android 15',
  isRevoked: false,
  revokedAt: null,
  expiresAt: future(),
  createdAt: new Date(),
  ...over,
});

describe('AuthService.refresh — rotation', () => {
  let auth: InstanceType<typeof AuthService>;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.reset();
    auth = new AuthService();
  });

  it('rejects a token that does not exist', async () => {
    dbMock.queueRows([]);
    await expect(auth.refresh('nope')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects an expired token', async () => {
    dbMock.queueRows([storedToken({ expiresAt: past() })]);
    await expect(auth.refresh('raw')).rejects.toMatchObject({ statusCode: 401 });
  });

  it('issues a new pair for a live token', async () => {
    dbMock.queueRows([storedToken()]);
    const result = await auth.refresh('raw');

    expect(result.access_token).toEqual(expect.any(String));
    expect(result.refresh_token).toEqual(expect.any(String));
    // Rotation means the presented token must not come back unchanged.
    expect(result.refresh_token).not.toBe('raw');
  });
});

describe('AuthService.refresh — reuse detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.reset();
  });

  /**
   * A phone on a weak connection can retry a queued refresh seconds after the
   * token rotated. Treating that as theft signed people out mid-session, so a
   * just-revoked token is honoured and the live one re-issued.
   */
  it('re-issues when the token was revoked moments ago', async () => {
    dbMock.queueMany(
      [storedToken({ isRevoked: true, revokedAt: new Date() })],
      [storedToken({ id: 'live-row' })], // the session's current live token
    );

    const result = await new AuthService().refresh('raw');
    expect(result.access_token).toEqual(expect.any(String));
  });

  it('trips reuse detection once the grace window has passed', async () => {
    dbMock.queueRows([
      storedToken({
        isRevoked: true,
        revokedAt: new Date(Date.now() - 5 * 60_000),
      }),
    ]);

    await expect(new AuthService().refresh('raw')).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_REUSE',
    });
  });

  /**
   * The blast radius matters as much as the detection. Revoking every session
   * meant one device's race signed the user out on all their other devices.
   *
   * The revoke is scoped by sessionId in the WHERE clause, which a mocked
   * database cannot verify — Drizzle's predicate is an opaque, circular object
   * and asserting on its internals would couple this test to Drizzle's shape.
   * What is checkable here is that exactly one scoped revoke is issued before
   * the throw; the predicate itself is covered by the manual check in the plan.
   */
  it('issues exactly one revoke before rejecting', async () => {
    dbMock.queueRows([
      storedToken({
        isRevoked: true,
        revokedAt: new Date(Date.now() - 5 * 60_000),
      }),
    ]);

    await expect(new AuthService().refresh('raw')).rejects.toThrow();

    const updates = dbMock.trace.filter((c) => c.method === 'update');
    expect(updates).toHaveLength(1);
  });

  it('rejects when the session has no live token left', async () => {
    dbMock.queueMany(
      [storedToken({ isRevoked: true, revokedAt: new Date() })],
      [], // nothing live for this session
    );

    await expect(new AuthService().refresh('raw')).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
