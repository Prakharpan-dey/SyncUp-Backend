import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp } from '../helpers/test-app.js';
import { legalRoutes } from '../../src/modules/legal/legal.routes.js';

/**
 * Play rejects a listing whose privacy policy link 404s, redirects to a login,
 * or is otherwise unreachable — so the properties worth pinning are that it
 * serves publicly, as HTML, with no auth, and states the things the Data Safety
 * form promises it states.
 */
describe('GET /legal/privacy', () => {
  let app: FastifyInstance;
  let body: string;
  let headers: Record<string, unknown>;

  beforeAll(async () => {
    app = await buildTestApp(legalRoutes, '/legal');
    const res = await app.inject({ method: 'GET', url: '/legal/privacy' });
    body = res.body;
    headers = res.headers as Record<string, unknown>;
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => app?.close());

  it('serves HTML without requiring a session', () => {
    expect(headers['content-type']).toContain('text/html');
    expect(body).toContain('<!doctype html>');
  });

  it('is indexable, unlike the auth pages', () => {
    // The auth pages set robots=noindex; a policy Play must crawl must not.
    expect(body).not.toContain('noindex');
  });

  it('locks the page down to inline styles only', () => {
    expect(String(headers['content-security-policy'])).toContain("default-src 'none'");
    expect(body).not.toContain('<script');
  });

  it('points at the account deletion route Play also requires', () => {
    expect(body).toContain('/account/delete');
  });

  it('carries a working contact address', () => {
    expect(body).toMatch(/mailto:[^"]+@[^"]+/);
  });

  // Each of these is asserted somewhere in the Data Safety form, so the page
  // and the form have to agree.
  it.each([
    ['no advertising or analytics', /no advertising/i],
    ['no location collection', /no location/i],
    ['deletion is permanent', /permanent/i],
    ['guest data stays on device', /guest/i],
    ['passwords are hashed', /bcrypt|hashed/i],
  ])('states %s', (_label, pattern) => {
    expect(body).toMatch(pattern);
  });
});
