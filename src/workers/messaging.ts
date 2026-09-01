import type { messaging } from 'firebase-admin';

/** Aliased so the exported signature does not name a deep internal path. */
type Messaging = messaging.Messaging;

/**
 * Firebase Admin, loaded once and only if credentials exist.
 *
 * Import is dynamic so the worker runs fine without Firebase configured — the
 * notification row is still written, it simply is not pushed.
 */
let messagingPromise: Promise<Messaging | null> | null = null;

export function getMessaging(): Promise<Messaging | null> {
  messagingPromise ??= (async () => {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT) {
      return null;
    }
    try {
      // `.default`, not the namespace: firebase-admin is CommonJS, and under a
      // dynamic ESM import every named export comes back undefined. Reading
      // `admin.apps` off the namespace threw a TypeError that this catch
      // swallowed, so push silently degraded to "not configured" even with
      // credentials present.
      const { default: admin } = await import('firebase-admin');
      if (admin.apps.length === 0) {
        admin.initializeApp({
          credential: process.env.FIREBASE_SERVICE_ACCOUNT
            ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            : admin.credential.applicationDefault(),
        });
      }
      return admin.messaging();
    } catch (err) {
      console.error('[NotificationWorker] Firebase init failed:', err);
      return null;
    }
  })();
  return messagingPromise;
}

