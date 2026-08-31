import { FastifyInstance } from 'fastify';

import { privacyPolicyPage } from './legal.pages.js';

/**
 * Public legal pages.
 *
 * Google Play requires a privacy policy at a URL that is reachable without
 * installing the app and without signing in, and rejects listings whose policy
 * link 404s or sits behind auth. The URL to paste into Play Console is:
 *
 *   https://<your-api-domain>/legal/privacy
 *
 * Unauthenticated by design — this router is registered outside the auth guard.
 */
export async function legalRoutes(app: FastifyInstance) {
  app.get('/privacy', async (_request, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      // Same tight policy as the other standalone pages: no scripts, no
      // remote loads. Inline styles are the only thing these pages use.
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      )
      // Static text — let Play's crawler and browsers cache it.
      .header('Cache-Control', 'public, max-age=3600')
      .send(privacyPolicyPage());
  });
}
