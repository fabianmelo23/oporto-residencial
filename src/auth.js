const crypto = require('crypto');
const { randomBytes, scryptSync, timingSafeEqual } = require('crypto');

const sessions = new Map();

/** Inactividad máxima antes de caducar (por defecto 5 min). */
function getSessionIdleMs() {
  const minutes = Number(process.env.SESSION_IDLE_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  return 5 * 60 * 1000;
}

/** Duración máxima absoluta de la sesión (por defecto 12 h). */
function getSessionAbsoluteMs() {
  const hours = Number(process.env.SESSION_ABSOLUTE_HOURS);
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !password) return false;
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = Buffer.from(hashHex, 'hex');
  const testHash = scryptSync(password, salt, 64);
  if (hash.length !== testHash.length) return false;
  return timingSafeEqual(hash, testHash);
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    userId: user.id,
    role: user.role,
    username: user.username,
    name: user.name,
    adminLevel: user.role === 'admin'
      ? (user.adminLevel === 'super' ? 'super' : 'admin')
      : undefined,
    mustChangePassword: user.role === 'resident' ? Boolean(user.mustChangePassword) : false,
    createdAt: new Date(now).toISOString(),
    lastActivityAt: now,
  });
  return token;
}

function isSessionExpired(session, now = Date.now()) {
  if (!session) return true;
  const createdMs = session.createdAt ? Date.parse(session.createdAt) : NaN;
  const lastActivity = Number(session.lastActivityAt) || createdMs;
  if (!Number.isFinite(createdMs) || !Number.isFinite(lastActivity)) return true;
  if (now - createdMs > getSessionAbsoluteMs()) return true;
  if (now - lastActivity > getSessionIdleMs()) return true;
  return false;
}

function touchSession(session, now = Date.now()) {
  if (session) session.lastActivityAt = now;
}

function getSession(token, { touch = false } = {}) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (isSessionExpired(session)) {
    sessions.delete(token);
    return null;
  }
  if (touch) touchSession(session);
  return session;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function destroySessionsForUser(userId, { exceptToken } = {}) {
  if (!userId) return;
  for (const [token, session] of sessions.entries()) {
    if (session.userId === userId && token !== exceptToken) {
      sessions.delete(token);
    }
  }
}

function clearSessions() {
  sessions.clear();
}

function purgeExpiredSessions(now = Date.now()) {
  let removed = 0;
  for (const [token, session] of sessions.entries()) {
    if (isSessionExpired(session, now)) {
      sessions.delete(token);
      removed += 1;
    }
  }
  return removed;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

function requireAuth(roles) {
  const allowed = roles ? (Array.isArray(roles) ? roles : [roles]) : null;
  return (req, res, next) => {
    const cookies = parseCookies(req);
    const token = cookies.session || req.headers['x-session-token'];
    const session = getSession(token, { touch: true });
    if (!session) {
      return res.status(401).json({
        error: 'Sesión expirada o no autenticado. Inicia sesión de nuevo.',
        code: 'SESSION_EXPIRED',
      });
    }
    if (allowed && !allowed.includes(session.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    req.session = session;
    req.sessionToken = token;

    const passwordExempt =
      (req.method === 'GET' && req.path === '/api/auth/me') ||
      (req.method === 'POST' && req.path === '/api/auth/logout') ||
      (req.method === 'POST' && req.path === '/api/auth/change-password');
    if (session.mustChangePassword && !passwordExempt) {
      return res.status(403).json({
        error: 'Debes cambiar tu contraseña temporal antes de continuar',
        code: 'MUST_CHANGE_PASSWORD',
      });
    }
    next();
  };
}

function validateResidentPassword(password) {
  if (!password || typeof password !== 'string') {
    return 'La contraseña nueva es requerida';
  }
  if (password.length < 6) {
    return 'La contraseña debe tener mínimo 6 caracteres';
  }
  if (!/[A-Z]/.test(password)) {
    return 'La contraseña debe incluir al menos 1 mayúscula';
  }
  if (!/[0-9]/.test(password)) {
    return 'La contraseña debe incluir al menos 1 número';
  }
  return null;
}

function requireSuperAdmin() {
  return (req, res, next) => {
    if (req.session?.role !== 'admin' || req.session?.adminLevel !== 'super') {
      return res.status(403).json({ error: 'Solo el Super Admin puede realizar esta acción' });
    }
    next();
  };
}

function publicAccount(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

function publicResident(resident) {
  if (!resident) return null;
  const { passwordHash, ...rest } = resident;
  return rest;
}

function publicStaff(member) {
  if (!member) return null;
  const { passwordHash, ...rest } = member;
  return rest;
}

function publicResidentSearch(resident) {
  if (!resident) return null;
  return {
    id: resident.id,
    name: resident.name,
    unit: resident.unit,
    username: resident.username,
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  isSessionExpired,
  touchSession,
  destroySession,
  destroySessionsForUser,
  clearSessions,
  purgeExpiredSessions,
  getSessionIdleMs,
  getSessionAbsoluteMs,
  parseCookies,
  requireAuth,
  requireSuperAdmin,
  validateResidentPassword,
  publicAccount,
  publicResident,
  publicStaff,
  publicResidentSearch,
};
