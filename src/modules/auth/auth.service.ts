import { db } from '../../core/db/drizzle.js';
import { users, refreshTokens, groups, groupMembers } from '../../core/db/schema/index.js';
import { eq, and, ne, sql } from 'drizzle-orm';
import { hashPassword, comparePassword } from '../../core/utils/password.js';
import { signAccessToken, generateRefreshToken, hashToken } from '../../core/utils/token.js';
import { invalidateAccountCache } from '../../core/middleware/auth.middleware.js';
import { enqueueEmail } from '../../core/queues/email.queue.js';
import { AppError } from '../../core/errors/app-errors.js';
import { env } from '../../core/config/env.js';
import { AuthTokenService } from './auth-token.service.js';
import { verificationEmail, passwordResetEmail } from './emails/templates.js';

/** The transaction handle Drizzle hands to `db.transaction`. */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A throwaway hash to compare against when no account matches, so a failed
 * login costs the same wall-clock time whether or not the email exists.
 *
 * Computed once on first miss and reused — hashing per request would be a
 * self-inflicted CPU cost on exactly the endpoint attackers hammer.
 */
let dummyHashPromise: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('not-a-real-password-placeholder');
  return dummyHashPromise;
}

/** Postgres unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === '23505';
}

/**
 * Builds a link for an email.
 *
 * These point at the API's own browser-facing routes rather than a `syncup://`
 * deep link. An email link is opened from wherever the user reads their mail —
 * desktop webmail, an in-app browser, a phone without the app — and a custom
 * scheme renders as a blank page in all of those.
 */
function buildEmailLink(path: string, token: string): string {
  const base = env.PUBLIC_APP_URL.replace(/\/+$/, '');
  return `${base}/auth/${path}?token=${encodeURIComponent(token)}`;
}

export class AuthService {
  private readonly authTokens = new AuthTokenService();

  private get refreshExpiryMs() {
    return env.JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  }

  async signUp(data: {
    email: string;
    password: string;
    username: string;
    display_name: string;
  }) {
    // Check email uniqueness
    const existingEmail = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, data.email))
      .limit(1);
    if (existingEmail.length > 0) {
      throw new AppError(409, 'Email already registered', 'CONFLICT');
    }

    // Check username uniqueness — case-insensitively, matching the
    // uq_users_username_lower index.
    const existingUsername = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${data.username})`)
      .limit(1);
    if (existingUsername.length > 0) {
      throw new AppError(409, 'Username already taken', 'CONFLICT');
    }

    // Create user
    const passwordHash = await hashPassword(data.password);

    let user: typeof users.$inferSelect;
    try {
      [user] = await db
        .insert(users)
        .values({
          email: data.email,
          passwordHash,
          username: data.username,
          displayName: data.display_name,
        })
        .returning();
    } catch (error) {
      // The checks above are not transactional, so two concurrent signups can
      // both pass them and race to the INSERT. Without this the loser surfaces
      // as a 500 rather than the 409 they actually deserve.
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'Email or username already taken', 'CONFLICT');
      }
      throw error;
    }

    // Generate tokens
    const { accessToken, refreshToken } = await this.generateTokenPair(user.id);

    // Fire-and-forget: a mail failure must not fail the signup. The user is
    // already able to use tasks and attendance; verification only gates the
    // social surface, and they can request a new link at any time.
    void this.sendVerificationEmail(user).catch((err) => {
      console.error('[Auth] Failed to enqueue verification email:', err);
    });

    return {
      user: this.sanitizeUser(user),
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  async login(email: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Always spend a bcrypt comparison, even when there is no account. Bailing
    // out early made an unknown email (~1ms) trivially distinguishable from a
    // wrong password (~250ms), which turns this endpoint into a way to discover
    // who has registered.
    const hashToCompare = user?.passwordHash ?? (await dummyPasswordHash());
    const valid = await comparePassword(password, hashToCompare);

    if (!user || !user.passwordHash || !valid) {
      throw new AppError(401, 'Invalid credentials', 'UNAUTHORIZED');
    }

    const { accessToken, refreshToken } = await this.generateTokenPair(user.id);

    return {
      user: this.sanitizeUser(user),
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  /**
   * Refresh token rotation with reuse detection.
   * If a revoked token is replayed → ALL tokens for that user are revoked.
   */
  async refresh(token: string) {
    const tokenHash = hashToken(token);
    const [stored] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!stored) {
      throw new AppError(401, 'Invalid refresh token', 'UNAUTHORIZED');
    }

    // REUSE DETECTION: if token was already revoked, attacker replaying → revoke ALL
    if (stored.isRevoked) {
      await db
        .update(refreshTokens)
        .set({ isRevoked: true })
        .where(eq(refreshTokens.userId, stored.userId));
      throw new AppError(401, 'Refresh token reuse detected. All sessions revoked.', 'TOKEN_REUSE');
    }

    // Token expired
    if (stored.expiresAt < new Date()) {
      throw new AppError(401, 'Refresh token expired', 'UNAUTHORIZED');
    }

    // Rotate: revoke old, issue new
    await db
      .update(refreshTokens)
      .set({ isRevoked: true })
      .where(eq(refreshTokens.id, stored.id));

    const { accessToken, refreshToken: newRefreshToken } =
      await this.generateTokenPair(stored.userId);

    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
    };
  }

  async logout(userId: string) {
    // Revoke all refresh tokens for this user
    await db
      .update(refreshTokens)
      .set({ isRevoked: true })
      .where(eq(refreshTokens.userId, userId));
  }

  /**
   * Permanently removes the account and everything it owns.
   *
   * A real DELETE, so the ON DELETE CASCADE foreign keys finally fire and take
   * tasks, subjects, attendance sessions, friendships, group memberships, feed
   * items, notifications and refresh tokens with them. It also frees the email
   * and username immediately, which soft-deleting did not — the old behaviour
   * left the address permanently unusable, including by its real owner.
   *
   * Two things must be handled before the cascade runs, and both are inside the
   * same transaction so a failure leaves the account intact.
   */
  async deleteAccount(userId: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

    // Re-authenticate: a stolen 15-minute access token should not be enough to
    // irreversibly destroy someone's account.
    //
    // An OAuth-created user has no password hash and therefore nothing to
    // confirm against; identity there rests on the token alone.
    if (user.passwordHash) {
      const valid = await comparePassword(password, user.passwordHash);
      if (!valid) throw new AppError(401, 'Incorrect password', 'UNAUTHORIZED');
    }

    await db.transaction(async (tx) => {
      await this.reassignOwnedGroups(tx, userId);
      await this.scrubUserFromFeedInteractions(tx, userId);

      // Cascades handle everything owned by this row.
      await tx.delete(users).where(eq(users.id, userId));
    });

    await invalidateAccountCache(userId);
  }

  /**
   * Hands each group the user owns to its longest-tenured other member, or
   * deletes it when they were the only one left.
   *
   * `groups.owner_id` cascades, so without this the group and every message of
   * its history would disappear the moment its creator left.
   */
  private async reassignOwnedGroups(tx: Transaction, userId: string) {
    const owned = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.ownerId, userId));

    for (const group of owned) {
      const [successor] = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(and(
          eq(groupMembers.groupId, group.id),
          ne(groupMembers.userId, userId),
        ))
        .orderBy(groupMembers.joinedAt)
        .limit(1);

      if (successor) {
        await tx.update(groups)
          .set({ ownerId: successor.userId, updatedAt: new Date() })
          .where(eq(groups.id, group.id));
        await tx.update(groupMembers)
          .set({ role: 'owner' })
          .where(and(
            eq(groupMembers.groupId, group.id),
            eq(groupMembers.userId, successor.userId),
          ));
      } else {
        await tx.delete(groups).where(eq(groups.id, group.id));
      }
    }
  }

  /**
   * Removes the user's reactions and comments from *other* people's feed items.
   *
   * Their own items go with the cascade, but these live as JSONB arrays on rows
   * belonging to someone else, so nothing would otherwise clear them.
   */
  private async scrubUserFromFeedInteractions(tx: Transaction, userId: string) {
    const marker = JSON.stringify([{ user_id: userId }]);

    // Both SET expressions read the pre-update column value, so filtering and
    // recounting in one statement is consistent.
    await tx.execute(sql`
      UPDATE feed_items SET
        reactions = (
          SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
          FROM jsonb_array_elements(reactions) e
          WHERE e->>'user_id' <> ${userId}
        ),
        reaction_count = (
          SELECT COUNT(*)
          FROM jsonb_array_elements(reactions) e
          WHERE e->>'user_id' <> ${userId}
        )
      WHERE reactions @> ${marker}::jsonb
    `);

    await tx.execute(sql`
      UPDATE feed_items SET
        comments = (
          SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
          FROM jsonb_array_elements(comments) e
          WHERE e->>'user_id' <> ${userId}
        ),
        comment_count = (
          SELECT COUNT(*)
          FROM jsonb_array_elements(comments) e
          WHERE e->>'user_id' <> ${userId}
        )
      WHERE comments @> ${marker}::jsonb
    `);
  }

  // ── Email verification ──

  private async sendVerificationEmail(user: typeof users.$inferSelect) {
    const raw = await this.authTokens.issue(user.id, 'email_verify');
    const url = buildEmailLink('verify-email', raw);
    const { subject, html } = verificationEmail({
      displayName: user.displayName,
      url,
    });
    await enqueueEmail({ to: user.email, subject, html });
  }

  /** Re-sends the verification link. No-ops if already verified. */
  async requestEmailVerification(userId: string) {
    const [user] = await db.select().from(users)
      .where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

    if (user.emailVerifiedAt) {
      return { already_verified: true };
    }

    await this.sendVerificationEmail(user);
    return { already_verified: false };
  }

  async confirmEmailVerification(token: string) {
    const userId = await this.authTokens.consume(token, 'email_verify');

    await db.update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, userId));

    // The guard caches verification state, so drop it or the social surface
    // stays closed for up to a TTL after the user has just confirmed.
    await invalidateAccountCache(userId);

    return { verified: true };
  }

  // ── Password reset ──

  /**
   * Starts a reset. Always resolves the same way, whether or not the address
   * belongs to an account — otherwise this endpoint reports which emails are
   * registered.
   */
  async forgotPassword(email: string) {
    const [user] = await db.select().from(users)
      .where(eq(users.email, email)).limit(1);

    // An OAuth-only account has no password to reset. Treated as a silent
    // no-op for the same reason: responding differently would leak how the
    // account was created.
    if (user?.passwordHash) {
      const raw = await this.authTokens.issue(user.id, 'password_reset');
      const url = buildEmailLink('reset-password', raw);
      const { subject, html } = passwordResetEmail({
        displayName: user.displayName,
        url,
      });
      await enqueueEmail({ to: user.email, subject, html });
    }
  }

  async resetPassword(token: string, newPassword: string) {
    const userId = await this.authTokens.consume(token, 'password_reset');

    const [user] = await db.select().from(users)
      .where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

    if (user.passwordHash) {
      const unchanged = await comparePassword(newPassword, user.passwordHash);
      if (unchanged) {
        throw new AppError(400, 'Choose a password you have not used before', 'BAD_REQUEST');
      }
    }

    await db.update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));

    // Whoever prompted the reset may already hold a session; end all of them.
    await this.revokeAllSessions(userId);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const [user] = await db.select().from(users)
      .where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');

    if (!user.passwordHash) {
      throw new AppError(400, 'This account signs in with Google', 'BAD_REQUEST');
    }

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(401, 'Incorrect password', 'UNAUTHORIZED');

    if (await comparePassword(newPassword, user.passwordHash)) {
      throw new AppError(400, 'New password must differ from the current one', 'BAD_REQUEST');
    }

    await db.update(users)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));

    await this.revokeAllSessions(userId);
    // Any reset link already in the user's inbox should stop working now that
    // they have demonstrably regained control of the account.
    await this.authTokens.invalidateOutstanding(userId, 'password_reset');
  }

  private async revokeAllSessions(userId: string) {
    await db.update(refreshTokens)
      .set({ isRevoked: true })
      .where(eq(refreshTokens.userId, userId));
  }

  async getMe(userId: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new AppError(404, 'User not found', 'NOT_FOUND');
    }

    return this.sanitizeUser(user);
  }

  // ── Private helpers ──

  private async generateTokenPair(userId: string) {
    const accessToken = signAccessToken(userId);
    const refreshToken = generateRefreshToken();

    await db.insert(refreshTokens).values({
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.refreshExpiryMs),
    });

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: typeof users.$inferSelect) {
    const { passwordHash, ...safe } = user;
    return {
      id: safe.id,
      username: safe.username,
      display_name: safe.displayName,
      email: safe.email,
      email_verified_at: safe.emailVerifiedAt?.toISOString() ?? null,
      photo_url: safe.photoUrl,
      college: safe.college,
      department: safe.department,
      semester: safe.semester,
      graduation_year: safe.graduationYear,
      privacy_searchable: safe.privacySearchable,
      privacy_sharing_default: safe.privacySharingDefault,
      notification_settings: safe.notificationSettings,
      created_at: safe.createdAt.toISOString(),
      updated_at: safe.updatedAt.toISOString(),
    };
  }
}
