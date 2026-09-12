import { verifyAccessToken } from '../utils/token.js';

type KeyedRequest = {
  ip: string;
  headers: { authorization?: string | string[] };
};

/**
 * Rate-limit bucket: the signed-in account, else the client address.
 *
 * Keying everything on the address would put a whole campus network — hundreds
 * of students behind one address — into a single bucket. A signed-in request
 * gets its own.
 *
 * The token is verified, not just decoded. The limiter runs before the auth
 * guard, and a decoded-but-unchecked `sub` would let anyone mint a fresh bucket
 * per request with a made-up token and walk straight past the limit. A token
 * that fails verification (forged, expired, malformed) falls back to the
 * address; the auth guard still rejects it afterwards.
 */
export function accountOrIpKey(request: KeyedRequest): string {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    try {
      return `user:${verifyAccessToken(header.slice('Bearer '.length)).sub}`;
    } catch {
      // Fall through to the address.
    }
  }
  return `ip:${request.ip}`;
}
