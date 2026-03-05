import crypto from 'node:crypto';

type AdminSession = {
  expiresAt: number;
};

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, AdminSession>();
let sessionRiskNoted = false;

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function createAdminSession(): string {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function validateAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  cleanupExpiredSessions();
  const session = sessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroyAdminSession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(token);
}

export function getAdminSessionTtlSeconds(): number {
  return Math.floor(SESSION_TTL_MS / 1000);
}

export function noteAdminSessionStoreRisk(): void {
  if (sessionRiskNoted || process.env.NODE_ENV !== 'production') {
    return;
  }

  sessionRiskNoted = true;
  console.warn(
    'Admin sessions are stored in-memory. Use a shared store (e.g., Redis) before scaling to multiple backend instances.',
  );
}
