import {
  BODY_FONT,
  MONO_FONT,
  INK,
  PAPER,
  PURPLE,
  escapeHtml,
} from '../auth/emails/pages.js';

/**
 * Where privacy questions and data requests should go.
 *
 * Google Play requires a working contact route in the policy, and will reject a
 * listing whose address bounces. Change this before submitting.
 */
const CONTACT_EMAIL = 'privacy@zeusdotdev.app';

/** Shown as "last updated"; bump whenever the policy text changes. */
const LAST_UPDATED = '31 August 2026';

/**
 * The long-form layout.
 *
 * `shell()` in auth/emails/pages.ts is built for short centred cards — a policy
 * needs left-aligned, readable body copy at a comfortable measure, so it gets
 * its own frame while keeping the same visual language.
 *
 * Deliberately indexable, unlike the auth pages: this URL goes in the Play
 * listing and must be publicly reachable.
 */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(title)} — SyncUp</title>
</head>
<body style="margin:0;background:${PAPER};font-family:${BODY_FONT};color:${INK};padding:24px;-webkit-font-smoothing:antialiased;">
  <main style="width:100%;max-width:720px;margin:0 auto;background:#fff;border:4px solid ${INK};box-shadow:10px 10px 0 ${INK};padding:40px 32px;box-sizing:border-box;">
    <p style="margin:0 0 10px;font-family:${MONO_FONT};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7A7A7A;">SyncUp</p>
    <h1 style="margin:0 0 6px;font-size:32px;font-weight:700;line-height:1.12;letter-spacing:-0.5px;">${escapeHtml(title)}</h1>
    <p style="margin:0 0 28px;font-family:${MONO_FONT};font-size:12px;color:#7A7A7A;">Last updated ${escapeHtml(LAST_UPDATED)}</p>
    ${body}
  </main>
</body>
</html>`;
}

const H2 = `margin:32px 0 10px;font-size:19px;font-weight:700;letter-spacing:-0.2px;`;
const P = `margin:0 0 14px;font-size:15.5px;line-height:1.6;color:#3A3A3A;`;
const UL = `margin:0 0 14px;padding-left:20px;font-size:15.5px;line-height:1.6;color:#3A3A3A;`;
const CALLOUT = `margin:0 0 14px;padding:16px;border:3px solid ${INK};background:${PAPER};font-size:15px;line-height:1.55;color:${INK};`;

export function privacyPolicyPage(): string {
  return page(
    'Privacy Policy',
    `
    <p style="${P}">SyncUp is a study app for tracking your own tasks and class attendance,
      and for sharing progress with friends you choose. This policy explains exactly what it
      stores, why, and how to get rid of it.</p>

    <div style="${CALLOUT}">
      <strong>The short version.</strong> SyncUp collects what it needs to run your account
      and sync your data. It has no advertising, no analytics or tracking SDKs, and no
      third-party trackers. Your data is never sold or shared for advertising. You can delete
      your account and everything in it at any time, without installing the app.
    </div>

    <h2 style="${H2}">Using SyncUp without an account</h2>
    <p style="${P}">You can use tasks and attendance as a guest. In guest mode your data stays
      on your device and is never sent to our servers. Creating an account is only required for
      the social features — friends, groups and the activity feed — because those involve other
      people.</p>

    <h2 style="${H2}">What we collect</h2>
    <p style="${P}"><strong>Account details.</strong> Your email address, username, display name,
      and a securely hashed form of your password. We never store your password itself. You may
      optionally add your college, semester and graduation year.</p>
    <p style="${P}"><strong>Your content.</strong> Tasks you create, subjects and attendance
      records you log, groups you join, and friend connections you make.</p>
    <p style="${P}"><strong>Activity you choose to share.</strong> When you complete a task, an
      entry may appear in your friends' or group's feed, along with any reactions. What this
      shows is governed by your sharing setting: <em>Everyone</em> shows the task name,
      <em>Summary</em> announces the completion without naming the task, and <em>None</em>
      shares nothing at all.</p>
    <p style="${P}"><strong>Device and session information.</strong> To keep you signed in and
      to deliver notifications, we store a notification token for each device, a rough device
      label such as "Pixel 8 Pro · Android 15" so you can recognise your own sessions, and
      hashed session tokens. Your IP address is processed briefly to rate-limit sign-in
      attempts; it is not retained as part of your profile.</p>

    <h2 style="${H2}">What we do not collect</h2>
    <ul style="${UL}">
      <li>No location data.</li>
      <li>No contacts, photos, camera or microphone access.</li>
      <li>No uploaded images — profile avatars are generated from your account, not stored files.</li>
      <li>No advertising identifiers, ad networks or analytics SDKs.</li>
      <li>No tracking of your activity in other apps or on other websites.</li>
    </ul>

    <h2 style="${H2}">Who can see your information</h2>
    <p style="${P}">Your username and display name are visible to someone who searches for your
      exact username, unless you set your profile to be findable only by friends, or by no one.
      Your tasks and attendance records are private to you and are never shown to other users —
      only the activity you choose to share reaches a feed. People you block cannot find you in
      search or send you requests.</p>

    <h2 style="${H2}">Service providers</h2>
    <p style="${P}">SyncUp relies on a small number of providers to operate. They process data
      only to provide their service to us:</p>
    <ul style="${UL}">
      <li><strong>Neon</strong> — database hosting.</li>
      <li><strong>Railway</strong> — application and cache hosting.</li>
      <li><strong>Resend</strong> — sending verification and password-reset emails.</li>
      <li><strong>Google Firebase Cloud Messaging</strong> — delivering push notifications.</li>
    </ul>
    <p style="${P}">We do not sell your personal information, and we do not share it for
      advertising or marketing purposes.</p>

    <h2 style="${H2}">Security</h2>
    <p style="${P}">All traffic between the app and our servers is encrypted with HTTPS.
      Passwords are hashed with bcrypt and are not recoverable, by us or anyone else. Session
      tokens are stored only as hashes, rotate each time they are used, and are held on your
      device in the platform's encrypted storage. You can review your active sessions in the app
      under Profile → Devices and sign out of any device remotely.</p>

    <h2 style="${H2}">Keeping and deleting your data</h2>
    <p style="${P}">We keep your information for as long as your account exists. Deleting your
      account is permanent and immediate: your profile, tasks, subjects, attendance records,
      friendships, group memberships, feed entries, notifications and sessions are all erased,
      and your email address and username become available for use again. There is no recovery
      period, so please export or note anything you want to keep first.</p>
    <p style="${P}">You can delete your account from inside the app under
      Profile → Delete Account, or — without installing the app — at
      <a href="/account/delete" style="color:${PURPLE};font-weight:600;">/account/delete</a>.</p>

    <h2 style="${H2}">Your rights</h2>
    <p style="${P}">You can access and correct your profile details in the app at any time,
      change what you share, restrict who can find you, and delete everything. If you would like
      a copy of your data or have a question this policy does not answer, contact us using the
      address below.</p>

    <h2 style="${H2}">Children</h2>
    <p style="${P}">SyncUp is intended for students in higher education and is not directed at
      children under 13. We do not knowingly collect information from children under 13. If you
      believe a child has created an account, contact us and we will remove it.</p>

    <h2 style="${H2}">Changes to this policy</h2>
    <p style="${P}">If this policy changes, the date at the top of this page will be updated.
      Significant changes will also be announced in the app.</p>

    <h2 style="${H2}">Contact</h2>
    <p style="${P}">Questions, requests or concerns:
      <a href="mailto:${escapeHtml(CONTACT_EMAIL)}" style="color:${PURPLE};font-weight:600;">${escapeHtml(CONTACT_EMAIL)}</a>
    </p>
    `,
  );
}
