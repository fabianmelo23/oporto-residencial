const crypto = require('crypto');
const { randomBytes, scryptSync, timingSafeEqual } = require('crypto');

const sessions = new Map();

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
  sessions.set(token, {
    userId: user.id,
    role: user.role,
    username: user.username,
    name: user.name,
    adminLevel: user.role === 'admin'
      ? (user.adminLevel === 'super' ? 'super' : 'admin')
      : undefined,
    mustChangePassword: user.role === 'resident' ? Boolean(user.mustChangePassword) : false,
    createdAt: new Date().toISOString(),
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  return sessions.get(token) || null;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function clearSessions() {
  sessions.clear();
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
    const session = getSession(token);
    if (!session) {
      return res.status(401).json({ error: 'No autenticado' });
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
  destroySession,
  clearSessions,
  parseCookies,
  requireAuth,
  requireSuperAdmin,
  validateResidentPassword,
  publicAccount,
  publicResident,
  publicStaff,
  publicResidentSearch,
};
