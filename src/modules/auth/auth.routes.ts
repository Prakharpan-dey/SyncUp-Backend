import { FastifyInstance, FastifyReply } from 'fastify';
import { authGuard } from '../../core/middleware/auth.middleware.js';
import { AppError } from '../../core/errors/app-errors.js';
import { AuthService } from './auth.service.js';
import {
  verifiedPage,
  invalidTokenPage,
  resetPasswordFormPage,
  passwordResetDonePage,
} from './emails/pages.js';
import {
  signUpSchema,
  loginSchema,
  refreshSchema,
  deleteAccountSchema,
  emailOnlySchema,
  confirmTokenSchema,
  resetPasswordSchema,
  changePasswordSchema,
} from './auth.schema.js';

const service = new AuthService();

/**
 * Prepares a reply to render one of the self-contained HTML pages.
 *
 * Helmet's default policy blocks inline styles, and these pages are styled
 * entirely with inline attributes. They load nothing external and run no
 * scripts, so the policy below allows exactly what they need and nothing more.
 */
function htmlReply(reply: FastifyReply) {
  return reply
    .type('text/html; charset=utf-8')
    .header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    );
}

/**
 * Credential endpoints are brute-force targets, so they get a far tighter budget
 * than the global 100/min. Keyed on IP plus submitted email, so one attacker
 * cannot burn through a shared-NAT IP's allowance for everyone behind it, and
 * cannot sidestep the limit by rotating the email either.
 */
const credentialRateLimit = {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '15 minutes',
      keyGenerator: (request: { ip: string; body?: unknown }) => {
        const email = (request.body as { email?: string } | undefined)?.email ?? '';
        return `${request.ip}:${email.toLowerCase()}`;
      },
    },
  },
};

/** Refresh is legitimate more often than login, but still not 100/min. */
const refreshRateLimit = {
  config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
};

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/signup — public
  app.post('/signup', credentialRateLimit, async (request, reply) => {
    const body = signUpSchema.parse(request.body);
    const result = await service.signUp(body);
    return reply.status(201).send(result);
  });

  // POST /auth/login — public
  app.post('/login', credentialRateLimit, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await service.login(body.email, body.password);
    return reply.send(result);
  });

  // POST /auth/refresh — public
  app.post('/refresh', refreshRateLimit, async (request, reply) => {
    const body = refreshSchema.parse(request.body);
    const result = await service.refresh(body.refresh_token);
    return reply.send(result);
  });

  // POST /auth/logout — protected
  app.post('/logout', { preHandler: [authGuard] }, async (request, reply) => {
    await service.logout(request.userId);
    return reply.status(204).send();
  });

  // POST /auth/delete — protected, and re-authenticates
  app.post('/delete', { preHandler: [authGuard] }, async (request, reply) => {
    const body = deleteAccountSchema.parse(request.body);
    await service.deleteAccount(request.userId, body.password);
    return reply.status(204).send();
  });

  // GET /auth/me — protected
  app.get('/me', { preHandler: [authGuard] }, async (request, reply) => {
    const user = await service.getMe(request.userId);
    return reply.send({ user });
  });

  // ── Email verification ──

  // Re-send the link. Protected: only the account holder can trigger mail to
  // their own address, so this cannot be used to spam someone else's inbox.
  app.post('/verify-email/request', {
    preHandler: [authGuard],
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const result = await service.requestEmailVerification(request.userId);
    return reply.send(result);
  });

  // Public: the token itself is the credential, and the user may be following
  // the link on a device where they are not signed in.
  app.post('/verify-email/confirm', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = confirmTokenSchema.parse(request.body);
    const result = await service.confirmEmailVerification(body.token);
    return reply.send(result);
  });

  // Browser entry point — this is what the emailed link points at.
  //
  // Verification completes here rather than handing off to the app, because an
  // email link has to work wherever it is opened: desktop webmail, an in-app
  // browser, or a phone that does not have SyncUp installed.
  app.get('/verify-email', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    htmlReply(reply);

    if (!token) return reply.status(400).send(invalidTokenPage('verification'));

    try {
      await service.confirmEmailVerification(token);
      return reply.send(verifiedPage());
    } catch (err) {
      // A token already spent usually means the user tapped the link twice.
      if (err instanceof AppError && err.code === 'INVALID_TOKEN') {
        return reply.status(400).send(invalidTokenPage('verification'));
      }
      throw err;
    }
  });

  // ── Password reset ──

  // Always 202, regardless of whether the address is registered — a different
  // response for unknown emails would make this an account-existence oracle.
  app.post('/forgot-password', credentialRateLimit, async (request, reply) => {
    const body = emailOnlySchema.parse(request.body);
    await service.forgotPassword(body.email);
    return reply.status(202).send({
      message: 'If that email is registered, a reset link is on its way.',
    });
  });

  app.post('/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);
    await service.resetPassword(body.token, body.password);
    return reply.status(204).send();
  });

  // Browser entry point for the emailed reset link — renders the form.
  // The token is not consumed here, only when the form is submitted.
  app.get('/reset-password', {
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    htmlReply(reply);

    if (!token) return reply.status(400).send(invalidTokenPage('reset'));
    return reply.send(resetPasswordFormPage(token));
  });

  // Submission target for the form above. Accepts urlencoded rather than JSON,
  // since it is a plain browser form post.
  app.post('/reset-password/web', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const { token, password, confirm } = body;
    htmlReply(reply);

    if (!token) return reply.status(400).send(invalidTokenPage('reset'));

    // Re-render the form with the problem rather than dumping a JSON error at
    // someone who is sitting in a browser.
    const reject = (message: string) =>
      reply.status(400).send(resetPasswordFormPage(token, message));

    if (!password || password.length < 8) {
      return reject('Password must be at least 8 characters.');
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return reject('Password must be at most 72 bytes.');
    }
    if (password !== confirm) {
      return reject('Those passwords do not match.');
    }

    try {
      await service.resetPassword(token, password);
      return reply.send(passwordResetDonePage());
    } catch (err) {
      if (err instanceof AppError) {
        return err.code === 'INVALID_TOKEN'
          ? reply.status(400).send(invalidTokenPage('reset'))
          : reject(err.message);
      }
      throw err;
    }
  });

  // POST /auth/change-password — protected
  app.post('/change-password', {
    preHandler: [authGuard],
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    await service.changePassword(
      request.userId,
      body.current_password,
      body.new_password,
    );
    return reply.status(204).send();
  });
}
