import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

const ADMIN_CSRF_COOKIE = 'admin_csrf';

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function ensureAdminCsrfCookie(req: Request, res: Response): string {
  const existing = typeof req.cookies?.[ADMIN_CSRF_COOKIE] === 'string'
    ? String(req.cookies[ADMIN_CSRF_COOKIE]).trim()
    : '';

  if (existing) {
    return existing;
  }

  const token = randomBytes(32).toString('hex');
  res.cookie(ADMIN_CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/admin',
  });

  return token;
}

export function adminCsrfProtection(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  const cookieToken = ensureAdminCsrfCookie(req, res);

  if (isSafeMethod(method)) {
    next();
    return;
  }

  const bodyToken = typeof req.body?._csrf === 'string' ? String(req.body._csrf).trim() : '';
  const headerToken = String(req.get('x-csrf-token') || '').trim();
  const requestToken = bodyToken || headerToken;

  if (!requestToken || requestToken !== cookieToken) {
    res.status(403).type('html').send('Invalid CSRF token. Please refresh and try again.');
    return;
  }

  next();
}

export const apiRateLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.API_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

export const adminRateLimiter = rateLimit({
  windowMs: Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.ADMIN_RATE_LIMIT_MAX || 200),
  standardHeaders: true,
  legacyHeaders: false,
});
