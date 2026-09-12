import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { AppError } from '../../core/errors/app-errors.js';
import { AuthService } from '../auth/auth.service.js';
import {
  deleteAccountFormPage,
  accountDeletedPage,
} from '../auth/emails/pages.js';

const service = new AuthService();

/**
 * Public, unauthenticated account management.
 *
 * Exists because Google Play requires an account-deletion path reachable
 * without installing the app — the in-app flow alone is not sufficient. The
 * URL to submit in Play Console is:
 *
 *   https://<your-api-domain>/account/delete
 */

const deleteFormSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.string().email()),
  password: z.string().min(1).max(1024),
  confirm: z.string(),
});

function htmlReply(reply: FastifyReply) {
  return reply
    .type('text/html; charset=utf-8')
    .header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    );
}

export async function accountRoutes(app: FastifyInstance) {
  app.get('/delete', async (_request, reply) => {
    return htmlReply(reply).send(deleteAccountFormPage());
  });

  app.post('/delete', {
    // Unauthenticated and destructive, so it gets the same tight budget as the
    // credential endpoints. Keyed on IP plus email so one attacker cannot
    // exhaust a shared-NAT IP's allowance for everyone behind it.
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        // After the form body is parsed, or the email in the key is empty.
        hook: 'preHandler' as const,
        keyGenerator: (request: { ip: string; body?: unknown }) => {
          const email = (request.body as { email?: string } | undefined)?.email ?? '';
          return `delete:${request.ip}:${email.toLowerCase()}`;
        },
      },
    },
  }, async (request, reply) => {
    htmlReply(reply);

    const parsed = deleteFormSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(
        deleteAccountFormPage('Enter a valid email address and your password.'),
      );
    }

    const { email, password, confirm } = parsed.data;

    if (confirm.trim().toUpperCase() !== 'DELETE') {
      return reply.status(400).send(
        deleteAccountFormPage('Type DELETE in the confirmation box to continue.'),
      );
    }

    try {
      await service.deleteAccountByCredentials(email, password, request.ip);
      return reply.send(accountDeletedPage());
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 401) {
        // Same message for an unknown address and a wrong password — this page
        // is public, and distinguishing them would reveal which emails exist.
        return reply.status(401).send(
          deleteAccountFormPage('Invalid email or password.'),
        );
      }
      throw err;
    }
  });
}
