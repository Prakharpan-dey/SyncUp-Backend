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

/**
 * Cosmetic name for the "signed in devices" list, e.g. "Pixel 8 Pro · Android 15".
 *
 * Optional because older clients do not send one, and nothing is authorised on
 * the strength of it — it only helps a user recognise which row to sign out.
 * It is rendered back to that same user, so it is length-capped to match the
 * column and left otherwise unconstrained.
 */
const deviceLabelField = z.string().trim().min(1).max(120).optional();

/**
 * Handles nobody may claim.
 *
 * Two reasons. Names like `admin` and `support` let an account pose as the
 * service itself, which matters more now that user search is an exact-username
 * lookup: whoever holds `support` is precisely who someone finds when they go
 * looking for it. The rest are path-like words kept clear so a future
 * `/settings` or `/api` route cannot collide with a profile handle.
 *
 * Compared case-insensitively, matching the lower(username) unique index.
 */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'superuser', 'sysadmin',
  'support', 'help', 'helpdesk', 'contact', 'info', 'abuse', 'security',
  'syncup', 'team', 'staff', 'official', 'moderator', 'mod',
  'api', 'app', 'www', 'mail', 'ftp', 'auth', 'login', 'signup', 'register',
  'me', 'you', 'self', 'user', 'users', 'account', 'accounts', 'profile',
  'settings', 'about', 'terms', 'privacy', 'legal', 'null', 'undefined',
  'everyone', 'all', 'none', 'anonymous', 'guest', 'system', 'bot',
]);

const usernameField = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[a-zA-Z0-9_]+$/,
    'Username can only contain letters, numbers, and underscores')
  .refine(
    (value) => !RESERVED_USERNAMES.has(value.toLowerCase()),
    'That username is reserved',
  );

export const signUpSchema = z.object({
  email: emailField,
  password: passwordField,
  username: usernameField,
  display_name: z.string().trim().min(1).max(80),
  device_label: deviceLabelField,
});

export const loginSchema = z.object({
  email: emailField,
  // Bounded so an oversized body cannot be fed straight into bcrypt as a
  // cheap CPU-exhaustion vector. Length is not otherwise validated here —
  // a wrong password should fail as a credential mismatch, not a 422.
  password: z.string().min(1).max(1024),
  device_label: deviceLabelField,
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/** Account deletion is irreversible, so it re-authenticates. */
export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(1024),
});

/**
 * Logout ends only the presented session. Both fields are optional so an older
 * client that sends nothing still logs out — of everything, in that case.
 */
export const logoutSchema = z.object({
  refresh_token: z.string().min(1).max(255).optional(),
  /** Push token to detach, so a signed-out device stops receiving alerts. */
  fcm_token: z.string().min(1).max(255).optional(),
});

export const registerDeviceSchema = z.object({
  fcm_token: z.string().min(1).max(255),
  platform: z.enum(['android', 'ios', 'web']),
});

export const sessionIdParamSchema = z.object({
  sessionId: z.string().uuid(),
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
