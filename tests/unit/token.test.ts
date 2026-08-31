import { describe, it, expect } from 'vitest';

import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
} from '../../src/core/utils/token.js';

describe('hashToken', () => {
  // Refresh tokens are looked up by hash, so the same input must always map to
  // the same row — and the stored value must not be the token itself.
  it('is deterministic', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });

  it('separates different tokens', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('never stores the token in the clear', () => {
    const raw = generateRefreshToken();
    expect(hashToken(raw)).not.toContain(raw);
  });

  it('produces a fixed-width sha256 hex digest', () => {
    expect(hashToken('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateRefreshToken', () => {
  it('does not repeat across a large sample', () => {
    const seen = new Set(Array.from({ length: 500 }, generateRefreshToken));
    expect(seen.size).toBe(500);
  });

  it('carries 40 bytes of entropy as hex', () => {
    expect(generateRefreshToken()).toMatch(/^[0-9a-f]{80}$/);
  });
});

describe('access tokens', () => {
  const USER = '11111111-1111-4111-8111-111111111111';

  it('round-trips the subject', () => {
    expect(verifyAccessToken(signAccessToken(USER)).sub).toBe(USER);
  });

  it('rejects a tampered payload', () => {
    const [h, p, s] = signAccessToken(USER).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'someone-else', iat: 1, exp: 9999999999 }),
    ).toString('base64url');
    expect(() => verifyAccessToken(`${h}.${forged}.${s}`)).toThrow();
    expect(p).toBeTruthy();
  });

  /**
   * The algorithm is pinned on verify. Without that, a token whose header says
   * `alg: none` would be accepted on its own say-so — the classic JWT forgery.
   */
  it('refuses an unsigned "alg: none" token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: USER, exp: 9999999999 }),
    ).toString('base64url');
    expect(() => verifyAccessToken(`${header}.${payload}.`)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    // Signed elsewhere with the wrong key.
    const foreign =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZXIiLCJleHAiOjk5OTk5OTk5OTl9.' +
      'aW52YWxpZHNpZ25hdHVyZQ';
    expect(() => verifyAccessToken(foreign)).toThrow();
  });

  it('rejects an expired token', () => {
    const jwt = require('jsonwebtoken');
    const expired = jwt.sign({ sub: USER }, process.env.JWT_ACCESS_SECRET!, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    expect(() => verifyAccessToken(expired)).toThrow();
  });
});
