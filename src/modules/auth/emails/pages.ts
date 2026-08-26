/**
 * Browser-facing pages for links opened from email.
 *
 * Email links have to survive being opened anywhere — desktop webmail, an
 * in-app browser, a phone without the app installed. A custom scheme
 * (`syncup://`) only resolves on a device that has the app, and renders as a
 * blank page everywhere else, so these flows are completed server-side in the
 * browser instead.
 */

const BRAND = '#6C5CE7';
const OK = '#00B894';
const BAD = '#FF6B6B';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(opts: {
  accent: string;
  icon: string;
  heading: string;
  body: string;
  extra?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>SyncUp</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#EDEDED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:24px;">
  <main style="max-width:420px;width:100%;background:#fff;border:3px solid #000;box-shadow:8px 8px 0 #000;padding:32px;text-align:center;">
    <div style="width:64px;height:64px;margin:0 auto 20px;background:${opts.accent};border:3px solid #000;display:flex;align-items:center;justify-content:center;font-size:32px;line-height:1;">${opts.icon}</div>
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#666;">SyncUp</p>
    <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:#111;">${escapeHtml(opts.heading)}</h1>
    <p style="margin:0;font-size:15px;line-height:1.55;color:#444;">${opts.body}</p>
    ${opts.extra ?? ''}
  </main>
</body>
</html>`;
}

export function verifiedPage(): string {
  return shell({
    accent: OK,
    icon: '&#10003;',
    heading: 'Email verified',
    body: 'You can head back to the SyncUp app — friends, groups and your feed are unlocked.',
  });
}

export function alreadyVerifiedPage(): string {
  return shell({
    accent: OK,
    icon: '&#10003;',
    heading: 'Already verified',
    body: 'This address was confirmed previously. Nothing more to do.',
  });
}

export function invalidTokenPage(what: 'verification' | 'reset'): string {
  const action = what === 'verification'
    ? 'Open the app and tap “Resend verification email” to get a fresh link.'
    : 'Open the app and request a new password reset link.';
  return shell({
    accent: BAD,
    icon: '&#33;',
    heading: 'This link has expired',
    body: `Links can only be used once, and they do not last forever. ${escapeHtml(action)}`,
  });
}

/** Form where a user chooses a new password after following a reset link. */
export function resetPasswordFormPage(token: string, error?: string): string {
  const errorBlock = error
    ? `<p style="margin:0 0 16px;padding:10px;background:${BAD};border:2px solid #000;font-size:14px;color:#000;">${escapeHtml(error)}</p>`
    : '';

  return shell({
    accent: BRAND,
    icon: '&#128273;',
    heading: 'Choose a new password',
    body: 'You will be signed out on every device once this is set.',
    extra: `
    <form method="POST" action="/auth/reset-password/web" style="margin-top:24px;text-align:left;">
      ${errorBlock}
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <label style="display:block;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#666;margin-bottom:6px;">New password</label>
      <input type="password" name="password" required minlength="8" autocomplete="new-password"
        style="width:100%;box-sizing:border-box;padding:12px;border:3px solid #000;font-size:16px;margin-bottom:16px;">
      <label style="display:block;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#666;margin-bottom:6px;">Confirm password</label>
      <input type="password" name="confirm" required minlength="8" autocomplete="new-password"
        style="width:100%;box-sizing:border-box;padding:12px;border:3px solid #000;font-size:16px;margin-bottom:20px;">
      <button type="submit"
        style="width:100%;padding:14px;background:${BRAND};color:#fff;border:3px solid #000;font-size:16px;font-weight:700;cursor:pointer;">
        SET NEW PASSWORD
      </button>
    </form>`,
  });
}

export function passwordResetDonePage(): string {
  return shell({
    accent: OK,
    icon: '&#10003;',
    heading: 'Password updated',
    body: 'Sign in to the SyncUp app with your new password.',
  });
}
