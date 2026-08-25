import { z } from 'zod';

/**
 * Email addresses are lowercased and trimmed at the edge.
 *
 * Storage and lookup are both case-sensitive, and mobile keyboards
 * auto-capitalize the first letter — so without this, someone who signs up as
 * "Satyam@gmail.com" is rejected when they later type "satyam@gmail.com", and
 * signing up again silently creates a second account.
 */
const emailField = z.string().trim().toLowerCase().pipe(z.string().email('Invalid email'));

/**
 * bcrypt silently truncates input at 72 bytes: without a cap, the tail of a
 * long passphrase is ignored and any variant sharing the first 72 bytes
 * authenticates successfully.
 */
const MAX_PASSWORD_BYTES = 72;

const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES,
    `Password must be at most ${MAX_PASSWORD_BYTES} bytes`,
  );

export const signUpSchema = z.object({
  email: emailField,
  password: passwordField,
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9_]+$/,
    'Username can only contain letters, numbers, and underscores'),
  display_name: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({
  email: emailField,
  // Bounded so an oversized body cannot be fed straight into bcrypt as a
  // cheap CPU-exhaustion vector. Length is not otherwise validated here —
  // a wrong password should fail as a credential mismatch, not a 422.
  password: z.string().min(1).max(1024),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/** Account deletion is irreversible, so it re-authenticates. */
export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(1024),
});

export const emailOnlySchema = z.object({
  email: emailField,
});

export const confirmTokenSchema = z.object({
  token: z.string().min(1).max(255),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(255),
  password: passwordField,
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: passwordField,
});
