import { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';

import { verifyAccessToken } from '../utils/token.js';
import { db } from '../db/drizzle.js';
import { users } from '../db/schema/index.js';
import { redis } from '../redis/redis.js';

// Augment FastifyRequest to include userId
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    /** True once the user has confirmed their email address. */
    userEmailVerified: boolean;
  }
}

/** Cached account state, keyed by user id. */
type AccountState = { exists: boolean; verified: boolean };

const CACHE_PREFIX = 'auth:user:';
/**
 * Short enough that a deletion or verification takes effect almost immediately,
 * long enough that a burst of requests costs one query rather than dozens.
 */
const CACHE_TTL_SECONDS = 30;

async function loadAccountState(userId: string): Promise<AccountState> {
  const cacheKey = `${CACHE_PREFIX}${userId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as AccountState;
  } catch {
    // Redis being unavailable must not lock everyone out — fall through to the
    // database and treat the cache as a pure optimization.
  }

  const [row] = await db
    .select({ id: users.id, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const state: AccountState = {
    exists: Boolean(row),
    verified: Boolean(row?.emailVerifiedAt),
  };

  try {
    await redis.set(cacheKey, JSON.stringify(state), 'EX', CACHE_TTL_SECONDS);
  } catch {
    // Same as above — a failed cache write is not a request failure.
  }

  return state;
}

/**
 * Drops the cached state for a user.
 *
 * Call after anything that should take effect before the TTL lapses: deleting
 * an account, confirming an email address.
 */
export async function invalidateAccountCache(userId: string): Promise<void> {
  try {
    await redis.del(`${CACHE_PREFIX}${userId}`);
  } catch {
    // Worst case the change is visible one TTL later.
  }
}

/**
 * Verifies the bearer token AND that the account behind it still exists.
 *
 * Signature verification alone is not enough: access tokens live for 15 minutes
 * and carry no revocation state, so a deleted or logged-out user would keep
 * full API access until their token expired.
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ message: 'Missing authentication token', code: 'UNAUTHORIZED' });
  }

  let userId: string;
  try {
    const token = authHeader.split(' ')[1];
    userId = verifyAccessToken(token).sub;
  } catch {
    return reply.status(401).send({ message: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  }

  const account = await loadAccountState(userId);
  if (!account.exists) {
    return reply.status(401).send({ message: 'Account no longer exists', code: 'ACCOUNT_GONE' });
  }

  request.userId = userId;
  request.userEmailVerified = account.verified;
}

/**
 * Gates the social surface (feed, friends, groups) on a confirmed email
 * address, so an unverified account cannot impersonate someone by signing up
 * with their address and being found in friend search.
 *
 * Must run after `authGuard`, which populates `userEmailVerified`.
 */
export async function requireVerifiedEmail(request: FastifyRequest, reply: FastifyReply) {
  if (!request.userEmailVerified) {
    return reply.status(403).send({
      message: 'Verify your email address to use social features',
      // Distinct code so the app can route to the verification screen rather
      // than showing a generic permission error.
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
}
