import { inArray, eq } from 'drizzle-orm';

import { db } from '../core/db/drizzle.js';
import { notifications, notificationTypeEnum, userDevices, users } from '../core/db/schema/index.js';
import { getMessaging } from './messaging.js';

/** One of the values the `notification_type` column accepts. */
export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];

/** The shape `enqueueNotification` puts on the queue. */
export interface NotificationJobData {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  deepLink?: string;
}

/**
 * Types that carry no preference and are therefore never muted here.
 *
 * `daily_digest` is retired: it was an enum value and a switch in the app with
 * no producer and no scheduler behind it, so it promised a daily summary the
 * app never sent. The enum value itself stays in Postgres — dropping one is a
 * destructive migration — but nothing creates or mutes it any more.
 */
type UnmanagedType = 'daily_digest';

/**
 * notification_type → the key used in `users.notification_settings`.
 *
 * The enum is singular and the preference keys are plural, so the mapping is
 * explicit rather than derived — a silent mismatch would quietly mute or
 * unmute a whole category. Typed exhaustively over every managed type, so
 * adding a notification type without a preference key fails the build.
 */
const PREFERENCE_KEY: Record<Exclude<NotificationType, UnmanagedType>, string> = {
  task_reminder: 'task_reminders',
  attendance_warning: 'attendance_warnings',
  friend_request: 'friend_requests',
  reaction: 'reactions',
  comment: 'comments',
  // Its own key rather than reusing friend_requests, so it can be muted
  // separately later. Nothing sets it yet, and an absent key counts as enabled.
  group_request: 'group_requests',
  group_invite: 'group_requests',
};

/** The preference key for a type, or undefined when the type carries none. */
function preferenceKeyFor(type: NotificationType): string | undefined {
  return (PREFERENCE_KEY as Record<string, string | undefined>)[type];
}

/**
 * Whether this category may be pushed to [userId].
 *
 * Enforced here rather than at each `enqueueNotification` call site so every
 * producer — current and future — is covered by one check.
 *
 * A category the user has not touched counts as enabled: someone who has never
 * opened the preferences screen should still be notified. An unrecognised type
 * is also allowed through, since silently dropping a notification is worse than
 * sending one the user did not ask to mute.
 */
export async function pushAllowed(
  userId: string,
  type: NotificationType,
): Promise<boolean> {
  const key = preferenceKeyFor(type);
  if (key === undefined) return true;

  const [recipient] = await db
    .select({ settings: users.notificationSettings })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const settings = (recipient?.settings ?? {}) as Record<string, unknown>;
  return settings[key] !== false;
}

/**
 * Delivers one queued notification.
 *
 * Separated from the BullMQ wiring so it can be driven directly: importing the
 * worker module constructs a `Worker`, which opens a Redis connection and makes
 * the delivery rules untestable.
 */
export async function handleNotificationJob(data: NotificationJobData) {
  const { userId, type, title, body, metadata, deepLink } = data;

  // The in-app notification centre reads from this table, so it is written
  // whether or not a push can be delivered.
  await db.insert(notifications).values({
    userId, type, title, body,
    metadata: metadata ?? {},
    deepLink,
  });

  // The preference governs interruptions, not whether the event happened — the
  // row above is still written, so a muted notification remains discoverable in
  // the in-app notification centre. Only the push is suppressed.
  if (!(await pushAllowed(userId, type))) {
    console.log(
      `[NotificationWorker] Stored for ${userId}: ${title} ` +
        `(push muted by preference: ${preferenceKeyFor(type)})`,
    );
    return;
  }

  const messaging = await getMessaging();
  if (!messaging) {
    console.log(`[NotificationWorker] Stored for ${userId}: ${title} (push not configured)`);
    return;
  }

  // Fan out to every registered device. Previously this was a single column on
  // `users`, so only the most recently signed-in device could be reached.
  const devices = await db
    .select({ token: userDevices.token })
    .from(userDevices)
    .where(eq(userDevices.userId, userId));

  if (devices.length === 0) {
    console.log(`[NotificationWorker] Stored for ${userId}: ${title} (no devices)`);
    return;
  }

  const response = await messaging.sendEachForMulticast({
    tokens: devices.map((d) => d.token),
    notification: { title, body },
    data: { deep_link: deepLink ?? '' },
  });

  // Uninstalls and reinstalls leave dead tokens behind; FCM tells us which, and
  // keeping them would mean retrying failures forever.
  const stale = response.responses.flatMap((r, i) => {
    const code = r.error?.code;
    const gone = code === 'messaging/registration-token-not-registered'
      || code === 'messaging/invalid-registration-token';
    return gone ? [devices[i].token] : [];
  });

  if (stale.length > 0) {
    await db.delete(userDevices).where(inArray(userDevices.token, stale));
  }

  console.log(
    `[NotificationWorker] Pushed to ${userId}: ${title} ` +
      `(${response.successCount}/${devices.length} delivered, ${stale.length} stale removed)`,
  );
}
