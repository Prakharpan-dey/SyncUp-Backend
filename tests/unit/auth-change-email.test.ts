import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/middleware/auth.middleware.js', () => ({
  invalidateAccountCache: vi.fn().mockResolvedValue(undefined),
}));

const { comparePassword, enqueueEmail, tokens } = vi.hoisted(() => ({
  comparePassword: vi.fn(),
  enqueueEmail: vi.fn().mockResolvedValue(undefined),
  tokens: {
    issue: vi.fn().mockResolvedValue('raw-token'),
    consume: vi.fn(),
    invalidateOutstanding: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../src/core/utils/password.js', () => ({
  comparePassword,
  hashPassword: vi.fn().mockResolvedValue('hashed'),
}));
vi.mock('../../src/core/queues/email.queue.js', () => ({ enqueueEmail }));
vi.mock('../../src/modules/auth/auth-token.service.js', () => ({
  AuthTokenService: class {
    issue = tokens.issue;
    consume = tokens.consume;
    invalidateOutstanding = tokens.invalidateOutstanding;
  },
}));

const { AuthService } = await import('../../src/modules/auth/auth.service.js');
const { redis } = await import('../../src/core/redis/redis.js');

const USER = '11111111-0000-0000-0000-000000000001';
const OLD = 'rhea@example.com';
const NEW = 'rhea.new@example.com';

const account = (over: Record<string, unknown> = {}) => ({
  id: USER,
  email: OLD,
  username: 'rhea',
  displayName: 'Rhea',
  passwordHash: 'stored-hash',
  emailVerifiedAt: new Date('2026-09-01T00:00:00Z'),
  photoUrl: null,
  college: null,
  department: null,
  semester: null,
  graduationYear: null,
  privacySearchable: 'everyone',
  privacySharingDefault: 'summary',
  notificationSettings: {},
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

let auth: InstanceType<typeof AuthService>;
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  auth = new AuthService();
});

describe('changing your email', () => {
  it('moves the account to the new address, unverified until confirmed', async () => {
    comparePassword.mockResolvedValue(true);
    dbMock.queueMany(
      [account()],                                    // the account
      [],                                             // nobody else has NEW
      [account({ email: NEW, emailVerifiedAt: null })], // the update
    );

    const user = await auth.changeEmail(USER, NEW, 'right', '203.0.113.7');

    expect(user).toMatchObject({ email: NEW, email_verified_at: null });
  });

  it('sends a confirmation link to the new address and tells the old one', async () => {
    comparePassword.mockResolvedValue(true);
    dbMock.queueMany([account()], [], [account({ email: NEW, emailVerifiedAt: null })]);

    await auth.changeEmail(USER, NEW, 'right');

    const recipients = enqueueEmail.mock.calls.map(([mail]) => mail.to).sort();
    expect(recipients).toEqual([NEW, OLD].sort());
    expect(tokens.issue).toHaveBeenCalledWith(USER, 'email_verify');
  });

  it('stops any reset link already sent to the old address', async () => {
    comparePassword.mockResolvedValue(true);
    dbMock.queueMany([account()], [], [account({ email: NEW, emailVerifiedAt: null })]);

    await auth.changeEmail(USER, NEW, 'right');
    expect(tokens.invalidateOutstanding).toHaveBeenCalledWith(USER, 'password_reset');
  });

  it('refuses a wrong password, and counts it towards the lockout', async () => {
    comparePassword.mockResolvedValue(false);
    dbMock.queueRows([account()]);

    await expect(auth.changeEmail(USER, NEW, 'wrong', '203.0.113.7'))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(redis.pipeline).toHaveBeenCalled(); // the counters were bumped
    expect(dbMock.called('update')).toBe(false);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('refuses an address another account already has', async () => {
    comparePassword.mockResolvedValue(true);
    dbMock.queueMany([account()], [{ id: 'someone-else' }]);

    await expect(auth.changeEmail(USER, NEW, 'right'))
      .rejects.toMatchObject({ statusCode: 409, field: 'new_email' });
    expect(dbMock.called('update')).toBe(false);
  });

  it('refuses the address it already has', async () => {
    comparePassword.mockResolvedValue(true);
    dbMock.queueRows([account()]);

    await expect(auth.changeEmail(USER, OLD, 'right'))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
