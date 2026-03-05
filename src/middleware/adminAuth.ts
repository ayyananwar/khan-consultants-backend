import { type NextFunction, type Request, type Response } from 'express';
import { validateAdminSession } from '../lib/adminSession.js';

export const ADMIN_SESSION_COOKIE = 'khan_admin_session';

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE] as string | undefined;
  const valid = validateAdminSession(token);

  if (!valid) {
    res.redirect('/admin/login');
    return;
  }

  next();
}
