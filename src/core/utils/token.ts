import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env.js';

const JWT_ALGORITHM = 'HS256' as const;

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY as any,
    algorithm: JWT_ALGORITHM,
  });
}

export function verifyAccessToken(token: string): { sub: string } {
  // Pin the algorithm explicitly — never let the token's own header choose it.
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: [JWT_ALGORITHM],
  }) as { sub: string };
}

export function generateRefreshToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
