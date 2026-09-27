import { redis } from '../../core/redis/redis.js';
import { AppError } from '../../core/errors/app-errors.js';

/**
 * Brute-force guardrails for every place a password is checked: sign-in,
 * change password, and both ways of deleting an account.
 *
 * Three counters, because each one alone is beatable:
 *
 * - **email + address** (10 per 15 min): the everyday lock. Keyed on the
 *   address too, so a stranger hammering someone's email locks only themselves
 *   out — the owner on their own network signs in as normal. The old lock was
 *   keyed on the email alone, which let anyone lock anyone out.
 * - **email, any address** (100 per hour): the ceiling for an attempt spread
 *   across many addresses, which the per-address counter cannot see.
 * - **address, any email** (50 per 15 min): stops one address trying one
 *   password against thousands of accounts. Set above a handful so a campus
 *   network — hundreds of students behind one address — is not locked by
 *   ordinary typos.
 *
 * Counted for unknown emails too: locking only real accounts would make the
 * lock itself reveal who has registered.
 *
 * Redis failures are swallowed. An outage degrades to "no lockout" rather than
 * locking everyone out of their accounts.
 */
export const EMAIL_IP_FAIL_LIMIT = 10;
const EMAIL_IP_FAIL_WINDOW_SECONDS = 15 * 60;
export const EMAIL_FAIL_LIMIT = 100;
const EMAIL_FAIL_WINDOW_SECONDS = 60 * 60;
export const IP_FAIL_LIMIT = 50;
const IP_FAIL_WINDOW_SECONDS = 15 * 60;

/** Accounts created from one address per hour. */
export const SIGNUP_IP_LIMIT = 10;
const SIGNUP_IP_WINDOW_SECONDS = 60 * 60;

const normalise = (email: string) => email.trim().toLowerCase();
/** A caller without a known address still gets counted, just together. */
const address = (ip?: string) => ip || 'unknown';

export const loginGuardKeys = {
  emailAndIp: (email: string, ip?: string) =>
    `login:fail:${normalise(email)}:${address(ip)}`,
  email: (email: string) => `login:fail:${normalise(email)}`,
  ip: (ip?: string) => `login:fail-ip:${address(ip)}`,
  signupIp: (ip?: string) => `signup:ip:${address(ip)}`,
};

const TOO_MANY = () =>
  new AppError(429, 'Too many failed sign-in attempts. Try again later.', 'TOO_MANY_ATTEMPTS');

async function read(key: string): Promise<number> {
  return Number(await redis.get(key)) || 0;
}

/**
 * Reads several counters in one command.
 *
 * These keys only exist once someone has failed, so the reads almost always
 * find nothing — but they are issued on every sign-in, password change and
 * account deletion. Three `GET`s was three billed commands to learn the same
 * thing one `MGET` does.
 */
async function readMany(keys: string[]): Promise<number[]> {
  const values = await redis.mget(...keys);
  return values.map((v) => Number(v) || 0);
}

/** Counts one more, starting the window on the first. */
async function bump(key: string, windowSeconds: number): Promise<void> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
}

/** Counts several, in one round trip. `EXPIRE` with `NX` sets the window only
 *  on the first failure, which is what made the read-back of `INCR` necessary. */
async function bumpMany(entries: [key: string, windowSeconds: number][]): Promise<void> {
  const pipeline = redis.pipeline();
  for (const [key, windowSeconds] of entries) {
    pipeline.incr(key);
    pipeline.expire(key, windowSeconds, 'NX');
  }
  await pipeline.exec();
}

/** Throws 429 once any of the three counters is spent. Call before comparing. */
export async function assertNotLockedOut(email: string, ip?: string): Promise<void> {
  let counts: number[];
  try {
    counts = await readMany([
      loginGuardKeys.emailAndIp(email, ip),
      loginGuardKeys.email(email),
      loginGuardKeys.ip(ip),
    ]);
  } catch {
    return;
  }

  const [fromHere, everywhere, thisAddress] = counts;
  if (
    fromHere >= EMAIL_IP_FAIL_LIMIT ||
    everywhere >= EMAIL_FAIL_LIMIT ||
    thisAddress >= IP_FAIL_LIMIT
  ) {
    throw TOO_MANY();
  }
}

/** Records a wrong password (or an unknown email) against all three counters. */
export async function recordLoginFailure(email: string, ip?: string): Promise<void> {
  try {
    await bumpMany([
      [loginGuardKeys.emailAndIp(email, ip), EMAIL_IP_FAIL_WINDOW_SECONDS],
      [loginGuardKeys.email(email), EMAIL_FAIL_WINDOW_SECONDS],
      [loginGuardKeys.ip(ip), IP_FAIL_WINDOW_SECONDS],
    ]);
  } catch {
    // Not worth failing the request over.
  }
}

/**
 * A correct password clears this email's counters, so someone who mistypes a
 * few times and then succeeds does not carry a countdown into their next
 * session. The address counter is left alone: it is shared with everyone else
 * on that network.
 */
export async function clearLoginFailures(email: string, ip?: string): Promise<void> {
  try {
    await Promise.all([
      redis.del(loginGuardKeys.emailAndIp(email, ip)),
      redis.del(loginGuardKeys.email(email)),
    ]);
  } catch {
    // Worst case the counter lapses with its window.
  }
}

/** Throws 429 once an address has created too many accounts this hour. */
export async function assertSignupAllowed(ip?: string): Promise<void> {
  let count: number;
  try {
    count = await read(loginGuardKeys.signupIp(ip));
  } catch {
    return;
  }
  if (count >= SIGNUP_IP_LIMIT) {
    throw new AppError(
      429,
      'Too many accounts created from this network. Try again later.',
      'TOO_MANY_ATTEMPTS',
    );
  }
}

/** Counts a sign-up attempt from this address. */
export async function recordSignup(ip?: string): Promise<void> {
  try {
    await bump(loginGuardKeys.signupIp(ip), SIGNUP_IP_WINDOW_SECONDS);
  } catch {
    // Not worth failing the request over.
  }
}
