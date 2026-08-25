import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../../core/db/drizzle.js';
import { authTokens } from '../../core/db/schema/index.js';
import { generateRefreshToken, hashToken } from '../../core/utils/token.js';
import { AppError } from '../../core/errors/app-errors.js';

export type AuthTokenType = 'email_verify' | 'password_reset';

/** Reset links are short-lived; verification links are not urgent. */
const TTL_MS: Record<AuthTokenType, number> = {
  email_verify: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

/**
 * Issues and redeems the single-use tokens sent by email.
 *
 * Only the hash is persisted, so the raw value exists exactly once — in the
 * email. It cannot be recovered from the database, by us or by anyone who
 * steals it.
 */
export class AuthTokenService {
  /**
   * Mints a token and invalidates any outstanding ones of the same type.
   *
   * Superseding matters: without it, every "resend" link a user ever requested
   * would stay live, widening the window for an old email to be intercepted.
   *
   * @returns the raw token — the only time it is available in plaintext.
   */
  async issue(userId: string, type: AuthTokenType): Promise<string> {
    await this.invalidateOutstanding(userId, type);

    const raw = generateRefreshToken(); // 40 random bytes, hex
    await db.insert(authTokens).values({
      userId,
      type,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + TTL_MS[type]),
    });

    return raw;
  }

  /**
   * Validates a token and marks it spent.
   *
   * The update is conditional on `usedAt IS NULL`, so two concurrent
   * confirmations cannot both succeed — the second matches no rows.
   *
   * @returns the id of the user the token belongs to.
   */
  async consume(raw: string, type: AuthTokenType): Promise<string> {
    const [token] = await db
      .select()
      .from(authTokens)
      .where(eq(authTokens.tokenHash, hashToken(raw)))
      .limit(1);

    // Same generic error for unknown, wrong-type, spent and expired tokens —
    // there is nothing useful to tell the caller apart, and distinguishing them
    // would confirm which tokens exist.
    const invalid = () =>
      new AppError(400, 'This link is invalid or has expired', 'INVALID_TOKEN');

    if (!token || token.type !== type) throw invalid();
    if (token.usedAt) throw invalid();
    if (token.expiresAt < new Date()) throw invalid();

    const claimed = await db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.id, token.id), isNull(authTokens.usedAt)))
      .returning({ id: authTokens.id });

    if (claimed.length === 0) throw invalid();

    return token.userId;
  }

  /** Drops a user's unspent tokens of one type. */
  async invalidateOutstanding(userId: string, type: AuthTokenType) {
    await db
      .delete(authTokens)
      .where(and(
        eq(authTokens.userId, userId),
        eq(authTokens.type, type),
        isNull(authTokens.usedAt),
      ));
  }
}
