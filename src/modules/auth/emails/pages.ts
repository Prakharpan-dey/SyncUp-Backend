/**
 * Browser-facing pages for links opened from email.
 *
 * Email links have to survive being opened anywhere — desktop webmail, an
 * in-app browser, a phone without the app installed. A custom scheme
 * (`syncup://`) only resolves on a device that has the app and renders as a
 * blank page everywhere else, so these flows complete server-side instead.
 *
 * Styling mirrors the app's neobrutalism: flat colour, 4px black borders, hard
 * offset shadows with no blur, square corners, heavy condensed headings and
 * letterspaced monospace labels. Everything is inline and self-contained — no
 * external stylesheets, fonts, images or scripts — so the pages render
 * instantly under a `default-src 'none'` policy.
 */

const INK = '#111111';
const PAPER = '#EDEDED';
const PURPLE = '#6C5CE7';
const TEAL = '#00CEC9';
const GREEN = '#00B894';
const RED = '#FF6B6B';

const BODY_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO_FONT =
  "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Icons are inline SVG rather than emoji: emoji render differently on every
 * platform and undercut the flat, drawn look of the rest of the design.
 */
const GLYPHS = {
  check: '<path d="M5 13.5 10.5 19 21 6.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="square"/>',
  cross: '<path d="M6.5 6.5 19.5 19.5M19.5 6.5 6.5 19.5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="square"/>',
  lock: '<path d="M6 12h14v10H6z" fill="none" stroke="currentColor" stroke-width="3"/><path d="M9.5 12V8.5a3.5 3.5 0 0 1 7 0V12" fill="none" stroke="currentColor" stroke-width="3"/>',
} as const;

function iconBlock(glyph: keyof typeof GLYPHS, background: string, ink: string) {
  return `<div style="width:72px;height:72px;background:${background};border:4px solid ${INK};box-shadow:6px 6px 0 ${INK};display:flex;align-items:center;justify-content:center;margin-bottom:28px;color:${ink};">
      <svg viewBox="0 0 26 26" width="34" height="34" aria-hidden="true">${GLYPHS[glyph]}</svg>
    </div>`;
}

function shell(opts: {
  glyph: keyof typeof GLYPHS;
  accent: string;
  glyphInk?: string;
  heading: string;
  body: string;
  extra?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="color-scheme" content="light">
  <title>SyncUp</title>
</head>
<body style="margin:0;min-height:100vh;box-sizing:border-box;display:flex;align-items:center;justify-content:center;background:${PAPER};font-family:${BODY_FONT};color:${INK};padding:24px;-webkit-font-smoothing:antialiased;">
  <main style="width:100%;max-width:440px;background:#fff;border:4px solid ${INK};box-shadow:10px 10px 0 ${INK};padding:36px 32px;box-sizing:border-box;">
    ${iconBlock(opts.glyph, opts.accent, opts.glyphInk ?? INK)}
    <p style="margin:0 0 10px;font-family:${MONO_FONT};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7A7A7A;">SyncUp</p>
    <h1 style="margin:0 0 14px;font-size:29px;font-weight:700;line-height:1.15;letter-spacing:-0.4px;">${escapeHtml(opts.heading)}</h1>
    <p style="margin:0;font-size:15.5px;line-height:1.55;color:#3A3A3A;">${opts.body}</p>
    ${opts.extra ?? ''}
  </main>
</body>
</html>`;
}

export function verifiedPage(): string {
  return shell({
    glyph: 'check',
    accent: GREEN,
    heading: "You're verified",
    body: 'Head back to SyncUp — friends, groups and your feed are now unlocked.',
  });
}

export function alreadyVerifiedPage(): string {
  return shell({
    glyph: 'check',
    accent: TEAL,
    heading: 'Already done',
    body: 'This address was confirmed earlier. Nothing else is needed.',
  });
}

export function invalidTokenPage(what: 'verification' | 'reset'): string {
  const next = what === 'verification'
    ? 'Open SyncUp and tap Resend verification email for a new one.'
    : 'Open SyncUp and request another reset link.';
  return shell({
    glyph: 'cross',
    accent: RED,
    heading: 'Link expired',
    body: `These links work once and then stop. ${escapeHtml(next)}`,
  });
}

const LABEL_STYLE = `display:block;font-family:${MONO_FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7A7A7A;margin-bottom:8px;`;
const INPUT_STYLE = `width:100%;box-sizing:border-box;padding:14px;border:3px solid ${INK};border-radius:0;background:#fff;font-family:${BODY_FONT};font-size:16px;color:${INK};outline-offset:3px;`;

/** Form where a user chooses a new password after following a reset link. */
export function resetPasswordFormPage(token: string, error?: string): string {
  const errorBlock = error
    ? `<p style="margin:0 0 20px;padding:12px 14px;background:${RED};border:3px solid ${INK};font-size:14.5px;font-weight:600;color:${INK};">${escapeHtml(error)}</p>`
    : '';

  return shell({
    glyph: 'lock',
    accent: PURPLE,
    glyphInk: '#FFFFFF',
    heading: 'New password',
    body: 'Setting this signs you out everywhere else.',
    extra: `
    <form method="POST" action="/auth/reset-password/web" style="margin-top:28px;">
      ${errorBlock}
      <input type="hidden" name="token" value="${escapeHtml(token)}">

      <label for="password" style="${LABEL_STYLE}">New password</label>
      <input id="password" type="password" name="password" required minlength="8"
        autocomplete="new-password" autofocus style="${INPUT_STYLE}margin-bottom:20px;">

      <label for="confirm" style="${LABEL_STYLE}">Confirm password</label>
      <input id="confirm" type="password" name="confirm" required minlength="8"
        autocomplete="new-password" style="${INPUT_STYLE}margin-bottom:26px;">

      <button type="submit"
        style="width:100%;padding:16px;background:${PURPLE};color:#fff;border:4px solid ${INK};border-radius:0;box-shadow:6px 6px 0 ${INK};font-family:${MONO_FONT};font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;">
        Set password
      </button>
    </form>`,
  });
}

export function passwordResetDonePage(): string {
  return shell({
    glyph: 'check',
    accent: GREEN,
    heading: 'Password changed',
    body: 'Sign in to SyncUp with your new password.',
  });
}
