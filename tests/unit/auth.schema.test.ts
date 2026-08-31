import { describe, it, expect } from 'vitest';
import { signUpSchema, loginSchema } from '../../src/modules/auth/auth.schema.js';

const validSignUp = {
  email: 'someone@example.com',
  password: 'CorrectHorse!23',
  username: 'someone',
  display_name: 'Some One',
};

describe('signUpSchema — email normalization (0.1)', () => {
  it('lowercases and trims, so a capitalized keyboard entry matches later', () => {
    const r = signUpSchema.parse({ ...validSignUp, email: '  Satyam@Gmail.com ' });
    expect(r.email).toBe('satyam@gmail.com');
  });

  it('still rejects a malformed address after trimming', () => {
    expect(signUpSchema.safeParse({ ...validSignUp, email: 'not-an-email' }).success)
      .toBe(false);
  });
});

describe('passwordField — bcrypt 72-byte truncation (4.1)', () => {
  it('accepts exactly 72 bytes', () => {
    expect(signUpSchema.safeParse({ ...validSignUp, password: 'a'.repeat(72) }).success)
      .toBe(true);
  });

  it('rejects 73 bytes, which bcrypt would silently truncate', () => {
    expect(signUpSchema.safeParse({ ...validSignUp, password: 'a'.repeat(73) }).success)
      .toBe(false);
  });

  it('counts bytes, not characters, so multi-byte input cannot slip past', () => {
    // 'é' is 2 bytes in UTF-8: 40 characters, 80 bytes.
    const multiByte = 'é'.repeat(40);
    expect(multiByte.length).toBeLessThanOrEqual(72);
    expect(signUpSchema.safeParse({ ...validSignUp, password: multiByte }).success)
      .toBe(false);
  });

  it('rejects a password under 8 characters', () => {
    expect(signUpSchema.safeParse({ ...validSignUp, password: 'short1!' }).success)
      .toBe(false);
  });
});

describe('usernameField — reserved words (4.2)', () => {
  it.each(['admin', 'root', 'support', 'syncup', 'api', 'help', 'moderator'])(
    'rejects %s', (name) => {
      const r = signUpSchema.safeParse({ ...validSignUp, username: name });
      expect(r.success).toBe(false);
    });

  it.each(['Admin', 'ADMIN', 'AdMiN'])(
    'rejects %s case-insensitively, matching the lower(username) index', (name) => {
      expect(signUpSchema.safeParse({ ...validSignUp, username: name }).success)
        .toBe(false);
    });

  it('allows a normal name that merely contains a reserved word', () => {
    expect(signUpSchema.safeParse({ ...validSignUp, username: 'admin_fan_99' }).success)
      .toBe(true);
  });

  it('still enforces the character set', () => {
    expect(signUpSchema.safeParse({ ...validSignUp, username: 'has spaces' }).success)
      .toBe(false);
  });
});

describe('loginSchema — CPU-exhaustion bound (4.1)', () => {
  it('normalizes the email the same way signup does', () => {
    const r = loginSchema.parse({ email: ' USER@Example.COM ', password: 'x' });
    expect(r.email).toBe('user@example.com');
  });

  it('rejects a multi-megabyte password rather than feeding it to bcrypt', () => {
    const huge = 'a'.repeat(2 * 1024 * 1024);
    expect(loginSchema.safeParse({ email: 'a@b.com', password: huge }).success)
      .toBe(false);
  });
});
