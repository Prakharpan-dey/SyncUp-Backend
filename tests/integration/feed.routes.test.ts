import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp } from '../helpers/test-app.js';

const CALLER = '11111111-1111-4111-8111-111111111111';
const ITEM = '44444444-4444-4444-8444-444444444444';

const react = vi.fn().mockResolvedValue({ reacted: true, reaction_count: 1 });
const getFeed = vi.fn().mockResolvedValue({ items: [], next_cursor: null });

vi.mock('../../src/modules/feed/feed.service.js', () => ({
  FeedService: class {
    react = react;
    getFeed = getFeed;
  },
}));

vi.mock('../../src/core/middleware/auth.middleware.js', () => ({
  authGuard: async (req: { userId: string; userEmailVerified: boolean }) => {
    req.userId = CALLER;
    req.userEmailVerified = true;
  },
  requireVerifiedEmail: async () => {},
  invalidateAccountCache: vi.fn(),
}));

const { feedRoutes } = await import('../../src/modules/feed/feed.routes.js');

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildTestApp(feedRoutes, '/feed');
});

describe('POST /feed/:id/react', () => {
  /**
   * The route used to answer 204. Reacting is now a toggle, so the client
   * cannot infer the result — it has to be told whether the reaction is on and
   * what the count became, or a local guess drifts the moment anyone toggles.
   */
  it('returns the toggled state and the new count', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/react`,
      payload: { emoji: '❤️' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reacted: true, reaction_count: 1 });
  });

  it('reports an undone reaction rather than assuming it was added', async () => {
    react.mockResolvedValueOnce({ reacted: false, reaction_count: 0 });

    const res = await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/react`,
      payload: { emoji: '❤️' },
    });

    expect(res.json()).toEqual({ reacted: false, reaction_count: 0 });
  });

  it('passes the caller through as the reacting user', async () => {
    await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/react`,
      payload: { emoji: '🔥' },
    });

    expect(react).toHaveBeenCalledWith(ITEM, CALLER, '🔥');
  });

  it('rejects a request with no emoji', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/react`,
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(react).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the service instead of a 500', async () => {
    const { AppError } = await import('../../src/core/errors/app-errors.js');
    react.mockRejectedValueOnce(
      new AppError(404, 'Feed item not found', 'NOT_FOUND'),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/react`,
      payload: { emoji: '❤️' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('commenting is gone', () => {
  it('no longer exposes a comment endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/comment`,
      payload: { text: 'hello' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('empty JSON body handling', () => {
  /**
   * The client used to force `Content-Type: application/json` on every request
   * via Dio's BaseOptions, including bodyless POSTs and DELETEs. Fastify
   * rejects that outright, and because the error handler only special-cased
   * 429 it surfaced as a 500 — logout and every DELETE looked like an outage.
   *
   * The status must be a 4xx, telling the caller they got it wrong.
   */
  it('answers 400, not 500, when a JSON content-type carries no body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/feed/${ITEM}/react`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
