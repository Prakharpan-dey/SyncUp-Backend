import { describe, it, expect, vi } from 'vitest';
import { z, ZodError } from 'zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

import { errorHandler } from '../../src/core/middleware/error-handler.js';
import { AppError } from '../../src/core/errors/app-errors.js';

/** Captures what the handler sent, without standing up a server. */
function fakeReply() {
  const sent = { status: 0, body: undefined as unknown };
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

const fakeRequest = () =>
  ({ log: { error: vi.fn() } }) as unknown as FastifyRequest;

const run = (error: unknown) => {
  const { reply, sent } = fakeReply();
  errorHandler(error as FastifyError, fakeRequest(), reply);
  return sent;
};

describe('errorHandler — application errors', () => {
  it('passes an AppError through with its status and code', () => {
    const sent = run(new AppError(403, 'Only the owner can do that', 'FORBIDDEN'));
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({
      message: 'Only the owner can do that',
      code: 'FORBIDDEN',
    });
  });

  /**
   * The signup conflicts carry `field` so the app can mark the offending input
   * instead of dropping one banner under a four-field form.
   */
  it('includes `field` when the error names one', () => {
    const sent = run(
      new AppError(409, 'Email already registered', 'CONFLICT', 'email'),
    );
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ field: 'email' });
  });

  it('omits `field` entirely when there is none', () => {
    const sent = run(new AppError(404, 'Not found', 'NOT_FOUND'));
    expect(sent.body).not.toHaveProperty('field');
  });
});

describe('errorHandler — validation', () => {
  it('turns a ZodError into a 422 with per-field messages', () => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    });
    const parsed = schema.safeParse({ email: 'nope', password: 'short' });

    const sent = run(parsed.success ? new Error('unreachable') : parsed.error);

    expect(sent.status).toBe(422);
    const body = sent.body as { code: string; errors: Record<string, string[]> };
    expect(body.code).toBe('VALIDATION_ERROR');
    // Both fields reported, so the client can mark both at once.
    expect(Object.keys(body.errors).sort()).toEqual(['email', 'password']);
  });

  it('reports a ZodError instance, not a generic 500', () => {
    const sent = run(new ZodError([]));
    expect(sent.status).toBe(422);
  });
});

describe('errorHandler — Fastify client errors', () => {
  /**
   * The regression this branch exists for. Only 429 used to be special-cased,
   * so every Fastify-native 4xx fell through to the catch-all and surfaced as a
   * 500 — a bodyless POST sent with a JSON content-type broke logout and every
   * DELETE, and looked like a server outage.
   */
  it('passes an empty-JSON-body error through as 400', () => {
    const sent = run({
      statusCode: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
      message: "Body cannot be empty when content-type is set to 'application/json'",
    });

    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: 'FST_ERR_CTP_EMPTY_JSON_BODY' });
  });

  it.each([400, 404, 413, 415, 431])('passes %i through unchanged', (code) => {
    const sent = run({ statusCode: code, message: 'client error' });
    expect(sent.status).toBe(code);
  });

  it('labels a 4xx with no code as BAD_REQUEST rather than dropping it', () => {
    const sent = run({ statusCode: 400, message: 'malformed' });
    expect(sent.body).toEqual({ message: 'malformed', code: 'BAD_REQUEST' });
  });

  it('gives 429 its own rate-limit message', () => {
    const sent = run({ statusCode: 429, message: 'rate limited' });
    expect(sent.status).toBe(429);
    expect(sent.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });
});

describe('errorHandler — unknown failures', () => {
  it('reports a generic 500 without leaking the message', () => {
    const sent = run(new Error('connection string user:hunter2@db'));
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('still returns 500 for a 5xx that carries a status', () => {
    const sent = run({ statusCode: 503, message: 'upstream down' });
    expect(sent.status).toBe(500);
  });
});
