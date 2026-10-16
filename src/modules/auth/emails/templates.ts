/**
 * Transactional email bodies.
 *
 * Deliberately plain: inline styles only, no external assets, no web fonts.
 * Mail clients strip <style> blocks and block remote images by default, and
 * anything image-heavy is more likely to be flagged as spam.
 */

const BRAND = '#6C5CE7';
const INK = '#111111';
const MUTED = '#666666';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(opts: {
  heading: string;
  body: string;
  /** Optional: a notice has nothing to click. */
  ctaLabel?: string;
  ctaUrl?: string;
  footer: string;
}): string {
  const url = opts.ctaUrl ? escapeHtml(opts.ctaUrl) : null;
  const cta = url && opts.ctaLabel
    ? `<a href="${url}" style="display:inline-block;padding:13px 22px;background:${BRAND};color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;border:3px solid #000000;">${escapeHtml(opts.ctaLabel)}</a>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">
            If the button doesn't work, paste this into your browser:<br>
            <span style="word-break:break-all;">${url}</span>
          </p>`
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#EDEDED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:${INK};">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#FFFFFF;border:3px solid #000000;">
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;color:${MUTED};text-transform:uppercase;">SyncUp</p>
          <h1 style="margin:0 0 16px;font-size:24px;line-height:1.2;">${escapeHtml(opts.heading)}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;">${opts.body}</p>
          ${cta}
          <p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${escapeHtml(opts.footer)}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function verificationEmail(opts: { displayName: string; url: string }) {
  return {
    subject: 'Confirm your SyncUp email',
    html: layout({
      heading: `Welcome, ${escapeHtml(opts.displayName)}`,
      body: 'Confirm your email address to add friends, join groups, and see your feed. Your tasks and attendance already work without this.',
      ctaLabel: 'CONFIRM EMAIL',
      ctaUrl: opts.url,
      footer: 'This link expires in 24 hours. If you did not create a SyncUp account, you can ignore this email.',
    }),
  };
}

export function passwordResetEmail(opts: { displayName: string; url: string }) {
  return {
    subject: 'Reset your SyncUp password',
    html: layout({
      heading: 'Reset your password',
      body: `Hi ${escapeHtml(opts.displayName)}, use the button below to choose a new password. You'll be signed out on all your devices once it's changed.`,
      ctaLabel: 'RESET PASSWORD',
      ctaUrl: opts.url,
      footer: 'This link expires in 1 hour and can only be used once. If you did not request a reset, ignore this email — your password has not changed.',
    }),
  };
}

/**
 * Sent to the *old* address when the account moves to a new one, so a
 * takeover — someone with the password moving the account out from under its
 * owner — does not go unnoticed.
 */
export function emailChangedNotice(opts: { displayName: string; newEmail: string }) {
  return {
    subject: 'Your SyncUp email was changed',
    html: layout({
      heading: 'Your email was changed',
      body: `Hi ${escapeHtml(opts.displayName)}, the email on your SyncUp account was just changed to <strong>${escapeHtml(opts.newEmail)}</strong>. Sign-in and password resets now go to that address.`,
      footer: 'If this was not you, someone may know your password. Sign in and change it straight away.',
    }),
  };
}

/** To the support inbox: someone reported a person or a post in the app. */
export function reportFiledEmail(opts: {
  reportId: string;
  reason: string;
  details: string | null;
  reporter: { id: string; username: string };
  reported: { id: string; username: string; displayName: string };
  post: { type: string; title: string; summary: string | null } | null;
}) {
  const row = (label: string, value: string) =>
    `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}<br>`;
  const post = opts.post
    ? row('Post', `${opts.post.type} — ${opts.post.title}`) +
      (opts.post.summary ? row('Post text', opts.post.summary) : '')
    : row('Post', 'none (the person was reported)');
  return {
    subject: `[SyncUp report] ${opts.reason}: @${opts.reported.username}`,
    html: layout({
      heading: 'New report',
      body:
        row('Reason', opts.reason) +
        row('Details', opts.details ?? '—') +
        row('Reported', `@${opts.reported.username} (${opts.reported.displayName}) ${opts.reported.id}`) +
        row('Reporter', `@${opts.reporter.username} ${opts.reporter.id}`) +
        post +
        row('Report id', opts.reportId),
      footer: 'Review it, then set reports.status to actioned or dismissed.',
    }),
  };
}
