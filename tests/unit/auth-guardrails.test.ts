import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

import { createDbMock } from '../helpers/db-mock.js';

const dbMock = createDbMock();
vi.mock('../../src/core/db/drizzle.js', () => ({ db: dbMock.db }));
vi.mock('../../src/core/middleware/auth.middleware.js', () => ({
  invalidateAccountCache: vi.fn().mockResolvedValue(undefined),
}));
const { comparePassword } = vi.hoisted(() => ({ comparePassword: vi.fn() }));
vi.mock('../../src/core/utils/password.js', () => ({
  comparePassword,
  hashPassword: vi.fn().mockResolvedValue('hashed'),
}));

const { redis } = await import('../../src/core/redis/redis.js');
const guard = await import('../../src/modules/auth/login-guard.js');
const { AuthService } = await import('../../src/modules/auth/auth.service.js');
const { accountOrIpKey } = await import('../../src/core/security/rate-limit-key.js');
const { signAccessToken } = await import('../../src/core/utils/token.js');

const r = redis as unknown as { get: Mock; incr: Mock; del: Mock; expire: Mock };
const { loginGuardKeys: keys } = guard;

const EMAIL = 'rhea@example.com';
const HOME = '203.0.113.7';
const ATTACKER = '198.51.100.9';
const USER = '11111111-0000-0000-0000-000000000001';

/** Redis counters, simulated. */
const store = new Map<string, number>();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.reset();
  store.clear();
  r.get.mockImplementation(async (k: string) => (store.has(k) ? String(store.get(k)) : null));
  r.incr.mockImplementation(async (k: string) => {
    const n = (store.get(k) ?? 0) + 1;
    store.set(k, n);
    return n;
  });
  r.del.mockImplementation(async (k: string) => Number(store.delete(k)));
  r.expire.mockResolvedValue(1);
});

async function fail(times: number, email = EMAIL, ip = ATTACKER) {
  for (let i = 0; i < times; i++) await guard.recordLoginFailure(email, ip);
}

describe('the login lockout', () => {
  it('lets an ordinary attempt through', async () => {
    await expect(guard.assertNotLockedOut(EMAIL, HOME)).resolves.toBeUndefined();
  });

  it('locks one email from one address after 10 failures', async () => {
    await fail(guard.EMAIL_IP_FAIL_LIMIT);
    await expect(guard.assertNotLockedOut(EMAIL, ATTACKER))
      .rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_ATTEMPTS' });
  });

  /** The old lock was keyed on the email alone, so anyone could lock anyone out. */
  it('does not lock the owner out on their own network', async () => {
    await fail(guard.EMAIL_IP_FAIL_LIMIT);
    await expect(guard.assertNotLockedOut(EMAIL, HOME)).resolves.toBeUndefined();
  });

  it('stops an attempt spread over many addresses at the per-email ceiling', async () => {
    store.set(keys.email(EMAIL), guard.EMAIL_FAIL_LIMIT);
    await expect(guard.assertNotLockedOut(EMAIL, HOME)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('stops one address trying a password against many emails', async () => {
    for (let i = 0; i < guard.IP_FAIL_LIMIT; i++) {
      await guard.recordLoginFailure(`user${i}@example.com`, ATTACKER);
    }
    await expect(guard.assertNotLockedOut('someone.new@example.com', ATTACKER))
      .rejects.toMatchObject({ statusCode: 429 });
  });

  it('treats capitals in the email as the same account', async () => {
    await fail(guard.EMAIL_IP_FAIL_LIMIT, 'Rhea@Example.com');
    await expect(guard.assertNotLockedOut(EMAIL, ATTACKER)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('clears this email on a correct password, but not the shared address count', async () => {
    await fail(5, EMAIL, HOME);
    await guard.clearLoginFailures(EMAIL, HOME);

    expect(store.has(keys.emailAndIp(EMAIL, HOME))).toBe(false);
    expect(store.has(keys.email(EMAIL))).toBe(false);
    expect(store.get(keys.ip(HOME))).toBe(5);
  });

  it('starts each window on the first failure only', async () => {
    await fail(2);
    expect(r.expire).toHaveBeenCalledTimes(3); // once per counter
  });

  it('fails open when Redis is down', async () => {
    r.get.mockRejectedValue(new Error('ECONNRESET'));
    await expect(guard.assertNotLockedOut(EMAIL, ATTACKER)).resolves.toBeUndefined();
  });
});

describe('the sign-up cap', () => {
  it('allows up to the limit from one address', async () => {
    for (let i = 0; i < guard.SIGNUP_IP_LIMIT - 1; i++) await guard.recordSignup(HOME);
    await expect(guard.assertSignupAllowed(HOME)).resolves.toBeUndefined();
  });

  it('stops the next one', async () => {
    for (let i = 0; i < guard.SIGNUP_IP_LIMIT; i++) await guard.recordSignup(HOME);
    await expect(guard.assertSignupAllowed(HOME)).rejects.toMatchObject({ statusCode: 429 });
    await expect(guard.assertSignupAllowed(ATTACKER)).resolves.toBeUndefined();
  });
});

/** Every password check shares the same counters, so none is a side door. */
describe('password checks feed the lockout', () => {
  const account = { id: USER, email: EMAIL, passwordHash: 'stored-hash' };
  let auth: InstanceType<typeof AuthService>;
  beforeEach(() => {
    auth = new AuthService();
  });

  it('sign-in counts a wrong password against this address', async () => {
    dbMock.queueRows([account]);
    comparePassword.mockResolvedValue(false);

    await expect(auth.login(EMAIL, 'wrong', undefined, ATTACKER))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(store.get(keys.emailAndIp(EMAIL, ATTACKER))).toBe(1);
  });

  it('sign-in refuses a locked address before touching the database', async () => {
    store.set(keys.emailAndIp(EMAIL, ATTACKER), guard.EMAIL_IP_FAIL_LIMIT);

    await expect(auth.login(EMAIL, 'anything', undefined, ATTACKER))
      .rejects.toMatchObject({ statusCode: 429 });
    expect(dbMock.called('select')).toBe(false);
    expect(comparePassword).not.toHaveBeenCalled();
  });

  it('change password counts a wrong current password', async () => {
    dbMock.queueRows([account]);
    comparePassword.mockResolvedValue(false);

    await expect(auth.changePassword(USER, 'wrong', 'NewPass!2026x', ATTACKER))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(store.get(keys.emailAndIp(EMAIL, ATTACKER))).toBe(1);
  });

  it('deleting in the app counts a wrong password, and respects the lock', async () => {
    dbMock.queueRows([account]);
    comparePassword.mockResolvedValue(false);
    await expect(auth.deleteAccount(USER, 'wrong', ATTACKER)).rejects.toMatchObject({ statusCode: 401 });
    expect(store.get(keys.emailAndIp(EMAIL, ATTACKER))).toBe(1);

    store.set(keys.emailAndIp(EMAIL, ATTACKER), guard.EMAIL_IP_FAIL_LIMIT);
    comparePassword.mockClear();
    dbMock.queueRows([account]);
    await expect(auth.deleteAccount(USER, 'guess', ATTACKER)).rejects.toMatchObject({ statusCode: 429 });
    expect(comparePassword).not.toHaveBeenCalled();
  });

  it('the web delete form counts a wrong password', async () => {
    dbMock.queueRows([account]);
    comparePassword.mockResolvedValue(false);

    await expect(auth.deleteAccountByCredentials(EMAIL, 'wrong', ATTACKER))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(store.get(keys.emailAndIp(EMAIL, ATTACKER))).toBe(1);
  });
});

describe('rate-limit buckets', () => {
  const req = (authorization?: string) => ({ ip: HOME, headers: { authorization } });

  it('gives a signed-in request its own bucket', () => {
    expect(accountOrIpKey(req(`Bearer ${signAccessToken(USER)}`))).toBe(`user:${USER}`);
  });

  /** An unverified `sub` would let anyone mint a fresh bucket per request. */
  it('falls back to the address for a forged token', () => {
    const forged = signAccessToken(USER).slice(0, -4) + 'abcd';
    expect(accountOrIpKey(req(`Bearer ${forged}`))).toBe(`ip:${HOME}`);
  });

  it('uses the address when there is no token', () => {
    expect(accountOrIpKey(req())).toBe(`ip:${HOME}`);
  });
});
