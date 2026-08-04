const express = require('express');
const cors = require('cors');
const path = require('path');
const {
  getDatabase,
  saveDatabase,
  loadDatabase,
  getDbPath,
  generateId,
  generateGuardShiftSchedule,
  guardShiftsToCsv,
  periodEndDate,
  periodsOverlap,
  getSuggestedStartDate,
  getShiftDayIndex,
  createGuardShiftPeriod,
  addLocalDays,
  formatLocalDate,
  parseLocalDate,
  getCurrentGuardShift,
  getOnDutyGuard,
  isGuardOnActiveDuty,
  findStaffByGuardName,
  evaluateStaffLoginAccess,
  getDataRevision,
  subscribeDataChanges,
} = require('./store');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  destroySessionsForUser,
  purgeExpiredSessions,
  getSession,
  parseCookies,
  getSessionIdleMs,
  getSessionAbsoluteMs,
  requireAuth,
  requireSuperAdmin,
  validateResidentPassword,
  publicResident,
  publicStaff,
  publicResidentSearch,
} = require('./auth');
const {
  notifyAdmins,
  notifyStaff,
  notifyResidents,
  notifyUser,
  getUserNotifications,
  getUnreadCount,
} = require('./notifications');

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production' || process.env.FORCE_SECURE_HEADERS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin / curl / server-to-server (no Origin header)
      if (!origin) return callback(null, true);
      if (!allowedOrigins.length) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(
  '/manual',
  express.static(path.join(__dirname, '..', 'docs', 'manual-administradora'))
);

loadDatabase();

// Limpieza periódica de sesiones caducadas
setInterval(() => {
  purgeExpiredSessions();
}, 5 * 60 * 1000).unref?.();

const loginAttempts = new Map();

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function getLoginRateLimit() {
  const max = Number(process.env.LOGIN_MAX_ATTEMPTS);
  const windowMin = Number(process.env.LOGIN_WINDOW_MINUTES);
  return {
    maxAttempts: Number.isFinite(max) && max > 0 ? max : 8,
    windowMs: (Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 15) * 60 * 1000,
  };
}

function checkLoginRateLimit(key) {
  const { maxAttempts, windowMs } = getLoginRateLimit();
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, failures: 0 };
    loginAttempts.set(key, entry);
  }
  if (entry.failures >= maxAttempts) {
    const retryAfterSec = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }
  return { allowed: true };
}

function recordLoginFailure(key) {
  const { windowMs } = getLoginRateLimit();
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, failures: 0 };
  }
  entry.failures += 1;
  loginAttempts.set(key, entry);
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function setSessionCookie(res, token) {
  const maxAgeSec = Math.floor(getSessionAbsoluteMs() / 1000);
  const secure =
    process.env.COOKIE_SECURE === 'true'
    || process.env.NODE_ENV === 'production'
    || process.env.RAILWAY_ENVIRONMENT;
  const parts = [
    `session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const secure =
    process.env.COOKIE_SECURE === 'true'
    || process.env.NODE_ENV === 'production'
    || process.env.RAILWAY_ENVIRONMENT;
  const parts = ['session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function findUserByUsername(username) {
  const db = getDatabase();
  const admin = db.admins.find((a) => a.username === username);
  if (admin) {
    return {
      ...admin,
      role: 'admin',
      adminLevel: admin.adminLevel === 'super' ? 'super' : 'admin',
    };
  }
  const staff = db.staff.find((s) => s.username === username && s.active !== false);
  if (staff) return { ...staff, role: 'staff' };
  const resident = db.residents.find((r) => r.username === username && r.active !== false);
  if (resident) return { ...resident, role: 'resident' };
  return null;
}

function findUserById(id, role) {
  const db = getDatabase();
  if (role === 'admin') return db.admins.find((a) => a.id === id);
  if (role === 'staff') return db.staff.find((s) => s.id === id);
  if (role === 'resident') return db.residents.find((r) => r.id === id);
  return null;
}

function appendAudit(entry) {
  const db = getDatabase();
  db.auditLog.push({
    id: generateId('audit'),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  saveDatabase(db);
}

function getSuperAdminIds(db) {
  return db.admins.filter((a) => a.adminLevel === 'super').map((a) => a.id);
}

function filterAuditLogsForViewer(logs, db, session) {
  if (session.adminLevel === 'super') return logs;
  const superIds = new Set(getSuperAdminIds(db));
  return logs.filter((l) => !superIds.has(l.actorId));
}

function enrichAuditLog(entry, db) {
  const result = { ...entry };
  if (entry.actorRole === 'resident' && entry.actorId) {
    const resident = db.residents.find((r) => r.id === entry.actorId);
    if (resident && resident.unit) {
      result.actorUnit = resident.unit;
    }
  }
  return result;
}

function getResidentUnit(session) {
  if (session.role !== 'resident') return null;
  const db = getDatabase();
  const resident = db.residents.find((r) => r.id === session.userId);
  return resident ? resident.unit : null;
}

// Health (público: sin rutas internas). Detalle de DB solo con ?detail=1 y sesión admin.
app.get('/health', (req, res) => {
  const payload = {
    status: 'ok',
    service: 'oporto-residencial',
  };
  if (req.query.detail === '1') {
    const cookies = parseCookies(req);
    const token = cookies.session || req.headers['x-session-token'];
    const session = getSession(token);
    if (session?.role === 'admin') {
      const dbPath = getDbPath();
      const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
      payload.dbPath = dbPath;
      payload.persistent = Boolean(volumeMount && dbPath.startsWith(volumeMount));
      payload.volumeMount = volumeMount;
      payload.sessionIdleMinutes = Math.round(getSessionIdleMs() / 60000);
      payload.sessionAbsoluteHours = Math.round(getSessionAbsoluteMs() / 3600000);
    }
  }
  res.json(payload);
});

app.get('/api/sync', requireAuth(), (req, res) => {
  res.json({ revision: getDataRevision() });
});

// Notifications
app.get('/api/notifications', requireAuth(), (req, res) => {
  const db = getDatabase();
  const items = getUserNotifications(db, req.session.userId, req.session.role);
  res.json({
    items,
    unreadCount: items.filter((n) => !n.read).length,
  });
});

app.get('/api/notifications/unread-count', requireAuth(), (req, res) => {
  const db = getDatabase();
  res.json({ unreadCount: getUnreadCount(db, req.session.userId, req.session.role) });
});

app.patch('/api/notifications/read-all', requireAuth(), (req, res) => {
  const db = getDatabase();
  let updated = 0;
  (db.notifications || []).forEach((n) => {
    if (n.userId === req.session.userId && n.userRole === req.session.role && !n.read) {
      n.read = true;
      updated += 1;
    }
  });
  if (updated) saveDatabase(db);
  res.json({ ok: true, updated });
});

app.patch('/api/notifications/:id/read', requireAuth(), (req, res) => {
  const db = getDatabase();
  const item = (db.notifications || []).find(
    (n) => n.id === req.params.id && n.userId === req.session.userId && n.userRole === req.session.role
  );
  if (!item) return res.status(404).json({ error: 'Notificación no encontrada' });
  item.read = true;
  saveDatabase(db);
  res.json(item);
});

app.get('/api/events', (req, res, next) => {
  if (req.query.token && !req.headers['x-session-token']) {
    req.headers['x-session-token'] = String(req.query.token);
  }
  next();
}, requireAuth(), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ revision: getDataRevision() })}\n\n`);

  const unsubscribe = subscribeDataChanges((payload) => {
    res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const rateKey = `${getClientIp(req)}:${String(username).trim().toLowerCase()}`;
  const rate = checkLoginRateLimit(rateKey);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    return res.status(429).json({
      error: 'Demasiados intentos de inicio de sesión. Espera unos minutos e inténtalo de nuevo.',
      code: 'LOGIN_RATE_LIMITED',
      retryAfterSec: rate.retryAfterSec,
    });
  }

  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    recordLoginFailure(rateKey);
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  clearLoginFailures(rateKey);

  // Demo: by default staff can log in regardless of the shift mesh.
  // Set ENFORCE_STAFF_DUTY=true to restore on-duty-only login.
  if (user.role === 'staff' && process.env.ENFORCE_STAFF_DUTY === 'true') {
    const db = getDatabase();
    const access = evaluateStaffLoginAccess(db.guardShiftPeriods, user.name);
    if (!access.allowed) {
      appendAudit({
        actorId: user.id,
        actorName: user.name,
        actorRole: user.role,
        action: 'login_denied',
        category: 'auth',
        entityType: 'session',
        entityId: user.id,
        details: `Login denegado (fuera de turno): ${user.username}`,
      });
      return res.status(403).json({
        error: access.message,
        code: 'STAFF_OFF_DUTY',
        nextDuty: access.nextDuty
          ? {
              shiftLabel: access.nextDuty.shiftLabel,
              type: access.nextDuty.type,
              schedule: access.nextDuty.schedule,
              date: access.nextDuty.date,
              startsAt: access.nextDuty.startsAt,
            }
          : null,
      });
    }
  }

  const token = createSession(user);
  setSessionCookie(res, token);
  const publicUser = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    adminLevel: user.role === 'admin' ? (user.adminLevel === 'super' ? 'super' : 'admin') : undefined,
    unit: user.unit || undefined,
    position: user.position || undefined,
    mustChangePassword: user.role === 'resident' ? Boolean(user.mustChangePassword) : false,
  };
  if (user.role === 'staff') {
    const db = getDatabase();
    publicUser.currentShift = getCurrentGuardShift(db.guardShiftPeriods, user.name);
  }
  appendAudit({
    actorId: user.id,
    actorName: user.name,
    actorRole: user.role,
    action: 'login',
    category: 'auth',
    entityType: 'session',
    entityId: user.id,
    details: `Inicio de sesión: ${user.username}`,
  });
  res.json({ token, user: publicUser });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  const user = findUserById(req.session.userId, req.session.role);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const payload = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: req.session.role,
    adminLevel: req.session.role === 'admin'
      ? (user.adminLevel === 'super' ? 'super' : 'admin')
      : undefined,
    unit: user.unit || undefined,
    position: user.position || undefined,
    mustChangePassword: req.session.role === 'resident' ? Boolean(user.mustChangePassword) : false,
  };
  if (req.session.role === 'staff') {
    const db = getDatabase();
    payload.currentShift = getCurrentGuardShift(db.guardShiftPeriods, user.name);
  }
  res.json(payload);
});

app.post('/api/auth/change-password', requireAuth('resident'), (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Contraseña antigua y nueva son requeridas' });
  }

  const policyError = validateResidentPassword(newPassword);
  if (policyError) {
    return res.status(400).json({ error: policyError });
  }

  const db = getDatabase();
  const resident = db.residents.find((r) => r.id === req.session.userId);
  if (!resident) return res.status(404).json({ error: 'Residente no encontrado' });

  if (!verifyPassword(currentPassword, resident.passwordHash)) {
    return res.status(401).json({ error: 'La contraseña antigua no es correcta' });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'La contraseña nueva debe ser diferente a la antigua' });
  }

  resident.passwordHash = hashPassword(newPassword);
  resident.mustChangePassword = false;
  req.session.mustChangePassword = false;
  saveDatabase(db);
  destroySessionsForUser(resident.id, { exceptToken: req.sessionToken });

  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'change_password',
    category: 'auth',
    entityType: 'resident',
    entityId: resident.id,
    details: 'Residente cambió su contraseña temporal',
  });

  res.json({
    ok: true,
    user: {
      id: resident.id,
      username: resident.username,
      name: resident.name,
      role: 'resident',
      unit: resident.unit,
      mustChangePassword: false,
    },
  });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Residents
app.get('/api/residents', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  res.json(db.residents.map(publicResident));
});

app.get('/api/residents/search', requireAuth(['admin', 'staff']), (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const db = getDatabase();
  let results = db.residents.filter((r) => r.active !== false);
  if (q) {
    results = results.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.unit.toLowerCase().includes(q) ||
        r.username.toLowerCase().includes(q)
    );
  }
  res.json(results.map(publicResidentSearch));
});

app.get('/api/residents/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const resident = db.residents.find((r) => r.id === req.params.id);
  if (!resident) return res.status(404).json({ error: 'Residente no encontrado' });
  res.json(publicResident(resident));
});

app.post('/api/residents', requireAuth('admin'), (req, res) => {
  const { name, unit, username, phone, email, tempPassword } = req.body || {};
  if (!name || !unit || !username || !tempPassword) {
    return res.status(400).json({ error: 'Nombre, unidad, usuario y contraseña temporal requeridos' });
  }
  const db = getDatabase();
  if (db.residents.some((r) => r.username === username)) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }
  const resident = {
    id: generateId('res'),
    name,
    unit,
    username,
    phone: phone || '',
    email: email || '',
    passwordHash: hashPassword(tempPassword),
    mustChangePassword: true,
    active: true,
  };
  db.residents.push(resident);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'residents',
    entityType: 'resident',
    entityId: resident.id,
    details: `Residente creado: ${name} (${unit})`,
  });
  res.status(201).json(publicResident(resident));
});

app.patch('/api/residents/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.residents.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Residente no encontrado' });
  const allowed = ['name', 'unit', 'phone', 'email', 'active'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.residents[idx][key] = req.body[key];
  }
  if (req.body.tempPassword) {
    db.residents[idx].passwordHash = hashPassword(req.body.tempPassword);
    db.residents[idx].mustChangePassword = true;
    destroySessionsForUser(db.residents[idx].id);
  }
  if (req.body.active === false) {
    destroySessionsForUser(db.residents[idx].id);
  }
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'update',
    category: 'residents',
    entityType: 'resident',
    entityId: req.params.id,
    details: `Residente actualizado: ${db.residents[idx].name}`,
  });
  res.json(publicResident(db.residents[idx]));
});

app.patch('/api/residents/:id/password', requireAuth('admin'), (req, res) => {
  const { password } = req.body || {};
  if (!password || !String(password).trim()) {
    return res.status(400).json({ error: 'Contraseña requerida' });
  }
  const db = getDatabase();
  const resident = db.residents.find((r) => r.id === req.params.id);
  if (!resident) return res.status(404).json({ error: 'Residente no encontrado' });

  resident.passwordHash = hashPassword(String(password).trim());
  resident.mustChangePassword = true;
  saveDatabase(db);
  destroySessionsForUser(resident.id);

  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'reset_password',
    category: 'residents',
    entityType: 'resident',
    entityId: resident.id,
    details: `Contraseña temporal reiniciada: ${resident.name} (${resident.unit})`,
  });

  res.json({ ok: true, mustChangePassword: true });
});

app.delete('/api/residents/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.residents.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Residente no encontrado' });
  const removed = db.residents.splice(idx, 1)[0];
  destroySessionsForUser(removed.id);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'delete',
    category: 'residents',
    entityType: 'resident',
    entityId: removed.id,
    details: `Residente eliminado: ${removed.name}`,
  });
  res.json({ ok: true });
});

// Visits
function visitDateOf(visit) {
  if (visit.visitDate) return visit.visitDate;
  if (visit.createdAt) return String(visit.createdAt).slice(0, 10);
  return null;
}

app.get('/api/visits/calendar', requireAuth(['admin', 'resident', 'staff']), (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Año y mes válidos requeridos' });
  }
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const db = getDatabase();
  let visits = db.visits;
  if (req.session.role === 'resident') {
    const unit = getResidentUnit(req.session);
    visits = visits.filter((v) => v.unit === unit);
  }
  const byDate = {};
  visits.forEach((v) => {
    const date = visitDateOf(v);
    if (!date || !date.startsWith(prefix)) return;
    if (!byDate[date]) byDate[date] = { date, count: 0 };
    byDate[date].count += 1;
  });
  res.json({
    year,
    month,
    days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
  });
});

app.get('/api/visits/day', requireAuth(['admin', 'resident', 'staff']), (req, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Fecha inválida' });
  }
  const db = getDatabase();
  let visits = db.visits.filter((v) => visitDateOf(v) === date);
  if (req.session.role === 'resident') {
    const unit = getResidentUnit(req.session);
    visits = visits.filter((v) => v.unit === unit);
  }
  res.json({
    date,
    items: visits.map((v) => publicVisitItem(v, req.session.role)),
  });
});

app.get('/api/visits', requireAuth(), (req, res) => {
  const db = getDatabase();
  let visits = db.visits;
  if (req.session.role === 'resident') {
    const unit = getResidentUnit(req.session);
    visits = visits.filter((v) => v.unit === unit);
  }
  res.json(visits.map((v) => publicVisitItem(v, req.session.role)));
});

function publicVisitItem(visit, viewerRole = null) {
  const { visitorSignature, ...rest } = visit;
  let pet = null;
  let hasPetPhoto = false;
  if (visit.pet && typeof visit.pet === 'object') {
    const { photo, ...petRest } = visit.pet;
    pet = petRest;
    hasPetPhoto = Boolean(photo);
  }
  const canSeeSignature = viewerRole !== 'staff';
  return {
    ...rest,
    pet,
    hasPet: Boolean(visit.hasPet),
    hasVisitorSignature: canSeeSignature ? Boolean(visitorSignature) : false,
    hasPetPhoto,
  };
}

function parseBool(value) {
  return value === true || value === 'true' || value === '1' || value === 'si' || value === 'sí';
}

app.post('/api/visits', requireAuth(['admin', 'resident']), (req, res) => {
  const {
    visitorName,
    document,
    purpose,
    unit,
    visitDate,
    vehicleModel,
    vehiclePlates,
    visitorPhone,
    entryTime,
    hasPet,
    pet,
    visitorSignature,
  } = req.body || {};
  if (!visitorName || !document) {
    return res.status(400).json({ error: 'Nombre y documento del visitante requeridos' });
  }
  const db = getDatabase();
  let visitUnit = unit;
  let residentId = null;
  let residentName = '';
  if (req.session.role === 'resident') {
    const resident = db.residents.find((r) => r.id === req.session.userId);
    visitUnit = resident.unit;
    residentId = resident.id;
    residentName = resident.name;
  } else if (!visitUnit) {
    return res.status(400).json({ error: 'Unidad requerida' });
  }

  const scheduledDate = visitDate && /^\d{4}-\d{2}-\d{2}$/.test(visitDate)
    ? visitDate
    : formatLocalDate(new Date());

  const withPet = parseBool(hasPet);
  let petData = null;
  if (withPet) {
    const p = pet && typeof pet === 'object' ? pet : {};
    const petName = String(p.name || '').trim();
    const species = String(p.species || '').trim().toLowerCase();
    const speciesOther = String(p.speciesOther || '').trim();
    const breed = String(p.breed || '').trim();
    if (!petName) {
      return res.status(400).json({ error: 'Nombre de la mascota requerido' });
    }
    if (!['perro', 'gato', 'otra'].includes(species)) {
      return res.status(400).json({ error: 'Especie de la mascota requerida' });
    }
    if (species === 'otra' && !speciesOther) {
      return res.status(400).json({ error: 'Indique la especie de la mascota' });
    }
    if (!visitorPhone || !String(visitorPhone).trim()) {
      return res.status(400).json({ error: 'Teléfono de contacto requerido cuando trae mascota' });
    }
    if (!parseBool(p.commitControl) || !parseBool(p.commitCleanup)
      || !parseBool(p.commitRules) || !parseBool(p.commitResponsibility)
      || !parseBool(p.authorizeData) || !parseBool(p.authorizePhoto)) {
      return res.status(400).json({ error: 'Debe aceptar todos los compromisos y autorizaciones de mascota' });
    }
    if (!isValidSignatureDataUrl(visitorSignature)) {
      return res.status(400).json({ error: 'Firma del visitante requerida' });
    }
    petData = {
      name: petName,
      species,
      speciesOther: species === 'otra' ? speciesOther : '',
      breed,
      vaccinationCurrent: parseBool(p.vaccinationCurrent),
      presentsVaccinationCard: parseBool(p.presentsVaccinationCard),
      commitments: {
        control: true,
        cleanup: true,
        rules: true,
        responsibility: true,
        authorizeData: true,
        authorizePhoto: true,
      },
      photo: p.photo && String(p.photo).startsWith('data:image/') ? p.photo : null,
    };
  }

  const visit = {
    id: generateId('visit'),
    unit: visitUnit,
    visitorName: String(visitorName).trim(),
    document: String(document).trim(),
    purpose: purpose ? String(purpose).trim() : (withPet ? 'Visita con mascota' : 'Visita'),
    visitDate: scheduledDate,
    entryTime: entryTime ? String(entryTime).trim() : '',
    visitorPhone: visitorPhone ? String(visitorPhone).trim() : '',
    vehicleModel: vehicleModel ? String(vehicleModel).trim() : '',
    vehiclePlates: vehiclePlates ? String(vehiclePlates).trim() : '',
    hasPet: withPet,
    pet: petData,
    visitorSignature: withPet ? visitorSignature : null,
    residentId,
    residentName: residentName || undefined,
    status: 'pendiente',
    createdAt: new Date().toISOString(),
    timeline: [],
  };
  db.visits.push(visit);
  const petLabel = withPet ? ` — con mascota (${petData.name})` : '';
  notifyAdmins(db, {
    title: 'Nueva visita programada',
    body: `${visit.visitorName} — Unidad ${visitUnit} — ${scheduledDate}${petLabel}`,
    category: 'visits',
    entityType: 'visit',
    entityId: visit.id,
    linkTab: 'visits',
  }, { excludeUserId: req.session.userId });
  notifyStaff(db, {
    title: 'Nueva visita programada',
    body: `${visit.visitorName} — Unidad ${visitUnit} — ${scheduledDate}${petLabel}`,
    category: 'visits',
    entityType: 'visit',
    entityId: visit.id,
    linkTab: 'sec-visits',
  }, { excludeUserId: req.session.userId });
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'visits',
    entityType: 'visit',
    entityId: visit.id,
    details: `Visita registrada: ${visit.visitorName} → ${visitUnit} (${scheduledDate})${petLabel}`,
  });
  res.status(201).json(publicVisitItem(visit, req.session.role));
});

app.patch('/api/visits/:id', requireAuth(['admin', 'staff']), (req, res) => {
  const { status } = req.body || {};
  if (!['pendiente', 'ingreso', 'despachado'].includes(status)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const db = getDatabase();
  const visit = db.visits.find((v) => v.id === req.params.id);
  if (!visit) return res.status(404).json({ error: 'Visita no encontrada' });
  visit.status = status;
  if (!visit.timeline) visit.timeline = [];
  if (status === 'ingreso' || status === 'despachado') {
    visit.timeline.push({
      status,
      at: new Date().toISOString(),
      by: req.session.userId,
    });
  }
  if (visit.residentId && (status === 'ingreso' || status === 'despachado')) {
    const statusLabel = status === 'ingreso' ? 'ingresó' : 'fue despachado';
    notifyUser(db, visit.residentId, 'resident', {
      title: `Visitante ${statusLabel}`,
      body: `${visit.visitorName} ${statusLabel} en unidad ${visit.unit}`,
      category: 'visits',
      entityType: 'visit',
      entityId: visit.id,
      linkTab: 'res-visits',
    });
  }
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'update',
    category: 'visits',
    entityType: 'visit',
    entityId: visit.id,
    details: `Visita ${status}: ${visit.visitorName}`,
  });
  res.json(publicVisitItem(visit, req.session.role));
});

app.delete('/api/visits/:id', requireAuth('admin'), requireSuperAdmin(), (req, res) => {
  const db = getDatabase();
  const idx = db.visits.findIndex((v) => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Visita no encontrada' });
  const removed = db.visits.splice(idx, 1)[0];
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'delete',
    category: 'visits',
    entityType: 'visit',
    entityId: removed.id,
    details: `Visita eliminada: ${removed.visitorName}`,
  });
  res.json({ ok: true });
});

function canAccessVisit(req, visit) {
  if (!visit) return false;
  if (req.session.role === 'resident') {
    return visit.residentId === req.session.userId || visit.unit === getResidentUnit(req.session);
  }
  return req.session.role === 'admin' || req.session.role === 'staff';
}

app.get('/api/visits/:id/signature', requireAuth(['admin', 'resident']), (req, res) => {
  const db = getDatabase();
  const visit = db.visits.find((v) => v.id === req.params.id);
  if (!visit || !visit.visitorSignature) {
    return res.status(404).json({ error: 'Firma no encontrada' });
  }
  if (!canAccessVisit(req, visit)) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return sendDataImage(res, visit.visitorSignature, 'Firma no encontrada');
});

app.get('/api/visits/:id/pet-photo', requireAuth(['admin', 'staff', 'resident']), (req, res) => {
  const db = getDatabase();
  const visit = db.visits.find((v) => v.id === req.params.id);
  const photo = visit && visit.pet && visit.pet.photo;
  if (!photo) {
    return res.status(404).json({ error: 'Foto de mascota no encontrada' });
  }
  if (!canAccessVisit(req, visit)) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return sendDataImage(res, photo, 'Foto de mascota no encontrada');
});

// Reservations
const AUTO_APPROVE_AREAS = new Set([
  'Turco 1',
  'Turco 2',
  'Televisor',
  'Mesa de Ping Pong',
]);

const DEPOSIT_REQUIRED_AREAS = new Set([
  'Salón social',
  'Kiosco 1',
  'Kiosco 2',
  'Kiosco 3',
]);

function timesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function reservationResidentName(db, reservation) {
  if (reservation.residentName) return reservation.residentName;
  if (reservation.residentId) {
    const resident = db.residents.find((r) => r.id === reservation.residentId);
    if (resident) return resident.name;
  }
  return `Unidad ${reservation.unit}`;
}

function publicDayReservation(db, r) {
  return {
    id: r.id,
    area: r.area,
    date: r.date,
    startTime: r.startTime,
    endTime: r.endTime,
    status: r.status,
    unit: r.unit,
    reservedBy: reservationResidentName(db, r),
  };
}

app.get('/api/reservations/calendar', requireAuth(['admin', 'resident', 'staff']), (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Año y mes válidos requeridos' });
  }
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const db = getDatabase();
  const byDate = {};
  db.reservations
    .filter((r) => r.status !== 'rechazada' && String(r.date || '').startsWith(prefix))
    .forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = { date: r.date, count: 0, areas: [] };
      byDate[r.date].count += 1;
      if (r.area && !byDate[r.date].areas.includes(r.area)) {
        byDate[r.date].areas.push(r.area);
      }
    });
  res.json({
    year,
    month,
    days: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)),
  });
});

app.get('/api/reservations/day', requireAuth(['admin', 'resident', 'staff']), (req, res) => {
  const date = String(req.query.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Fecha inválida' });
  }
  const db = getDatabase();
  const items = db.reservations
    .filter((r) => r.date === date && r.status !== 'rechazada')
    .map((r) => publicDayReservation(db, r))
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.area.localeCompare(b.area, 'es'));
  res.json({ date, items });
});

app.get('/api/reservations', requireAuth(), (req, res) => {
  const db = getDatabase();
  let reservations = db.reservations;
  if (req.session.role === 'resident') {
    const unit = getResidentUnit(req.session);
    reservations = reservations.filter((r) => r.unit === unit);
  }
  res.json(
    reservations.map((r) => ({
      ...r,
      residentName: reservationResidentName(db, r),
    }))
  );
});

app.post('/api/reservations', requireAuth(['admin', 'resident']), (req, res) => {
  const { area, date, startTime, endTime, notes, unit } = req.body || {};
  if (!area || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Área, fecha y horario requeridos' });
  }
  if (endTime <= startTime) {
    return res.status(400).json({ error: 'La hora de fin debe ser posterior a la de inicio' });
  }

  const db = getDatabase();
  let resUnit = unit;
  let residentId = null;
  let residentName = req.session.name || '';
  if (req.session.role === 'resident') {
    const resident = db.residents.find((r) => r.id === req.session.userId);
    resUnit = resident.unit;
    residentId = resident.id;
    residentName = resident.name;
  } else if (!resUnit) {
    return res.status(400).json({ error: 'Unidad requerida' });
  }

  const conflict = db.reservations.find(
    (r) =>
      r.status !== 'rechazada' &&
      r.date === date &&
      r.area === area &&
      timesOverlap(startTime, endTime, r.startTime, r.endTime)
  );
  if (conflict) {
    const who = reservationResidentName(db, conflict);
    return res.status(409).json({
      error: `${area} ya está reservado de ${conflict.startTime} a ${conflict.endTime} por ${who}`,
    });
  }

  const status = AUTO_APPROVE_AREAS.has(area) ? 'aprobada' : 'pendiente';
  const requiresDeposit = DEPOSIT_REQUIRED_AREAS.has(area);

  const reservation = {
    id: generateId('resv'),
    unit: resUnit,
    area,
    date,
    startTime,
    endTime,
    status,
    requiresDeposit,
    residentId,
    residentName,
    notes: notes || '',
    createdAt: new Date().toISOString(),
  };
  db.reservations.push(reservation);
  const reservationBody = `Unidad ${resUnit} — ${residentName || 'Residente'} — ${area} — ${date} ${startTime}-${endTime}`;
  let reservationTitle = 'Nueva reserva';
  if (requiresDeposit || status === 'pendiente') {
    reservationTitle = requiresDeposit ? 'Reserva pendiente de depósito' : 'Nueva reserva pendiente';
  } else if (status === 'aprobada') {
    reservationTitle = 'Nueva reserva aprobada';
  }
  const reservationNotif = {
    title: reservationTitle,
    body: reservationBody,
    category: 'reservations',
    entityType: 'reservation',
    entityId: reservation.id,
  };
  notifyAdmins(db, { ...reservationNotif, linkTab: 'reservations' }, { excludeUserId: req.session.userId });
  notifyStaff(db, { ...reservationNotif, linkTab: 'sec-reservations' }, { excludeUserId: req.session.userId });
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'reservations',
    entityType: 'reservation',
    entityId: reservation.id,
    details: `Reserva ${status}: ${area} ${date}`,
  });
  res.status(201).json({
    ...reservation,
    message: requiresDeposit
      ? 'Reserva registrada. Realiza el depósito en portería para que administración pueda aprobarla.'
      : status === 'aprobada'
        ? 'Reserva aprobada automáticamente.'
        : 'Reserva registrada y pendiente de aprobación.',
  });
});

app.patch('/api/reservations/:id', requireAuth('admin'), (req, res) => {
  const { status } = req.body || {};
  if (!['pendiente', 'aprobada', 'rechazada'].includes(status)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const db = getDatabase();
  const reservation = db.reservations.find((r) => r.id === req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' });
  reservation.status = status;
  if (reservation.residentId && (status === 'aprobada' || status === 'rechazada')) {
    notifyUser(db, reservation.residentId, 'resident', {
      title: status === 'aprobada' ? 'Reserva aprobada' : 'Reserva rechazada',
      body: `${reservation.area} — ${reservation.date} ${reservation.startTime}-${reservation.endTime}`,
      category: 'reservations',
      entityType: 'reservation',
      entityId: reservation.id,
      linkTab: 'res-reservations',
    });
  }
  if (status === 'aprobada' || status === 'rechazada') {
    notifyStaff(db, {
      title: status === 'aprobada' ? 'Reserva aprobada' : 'Reserva rechazada',
      body: `Unidad ${reservation.unit} — ${reservation.area} — ${reservation.date} ${reservation.startTime}-${reservation.endTime}`,
      category: 'reservations',
      entityType: 'reservation',
      entityId: reservation.id,
      linkTab: 'sec-reservations',
    }, { excludeUserId: req.session.userId });
  }
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'update',
    category: 'reservations',
    entityType: 'reservation',
    entityId: reservation.id,
    details: `Reserva ${status}: ${reservation.area}`,
  });
  res.json(reservation);
});

app.delete('/api/reservations/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.reservations.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Reserva no encontrada' });
  const removed = db.reservations.splice(idx, 1)[0];
  saveDatabase(db);
  res.json({ ok: true });
});

// Maintenance
app.get('/api/maintenance', requireAuth(), (req, res) => {
  const db = getDatabase();
  let items = db.maintenance;
  if (req.session.role === 'resident') {
    const unit = getResidentUnit(req.session);
    items = items.filter((m) => m.unit === unit);
  }
  res.json(items);
});

app.post('/api/maintenance', requireAuth(['admin', 'resident']), (req, res) => {
  const { title, description, priority, unit } = req.body || {};
  if (!title || !description) {
    return res.status(400).json({ error: 'Título y descripción requeridos' });
  }
  const db = getDatabase();
  let maintUnit = unit;
  let residentId = null;
  if (req.session.role === 'resident') {
    const resident = db.residents.find((r) => r.id === req.session.userId);
    maintUnit = resident.unit;
    residentId = resident.id;
  } else if (!maintUnit) {
    return res.status(400).json({ error: 'Unidad requerida' });
  }
  const item = {
    id: generateId('maint'),
    unit: maintUnit,
    title,
    description,
    status: 'abierto',
    priority: priority || 'media',
    residentId,
    createdAt: new Date().toISOString(),
  };
  db.maintenance.push(item);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'maintenance',
    entityType: 'maintenance',
    entityId: item.id,
    details: `Mantenimiento: ${title}`,
  });
  res.status(201).json(item);
});

app.patch('/api/maintenance/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const item = db.maintenance.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Registro no encontrado' });
  const allowed = ['title', 'description', 'status', 'priority'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) item[key] = req.body[key];
  }
  saveDatabase(db);
  res.json(item);
});

app.delete('/api/maintenance/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.maintenance.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Registro no encontrado' });
  db.maintenance.splice(idx, 1);
  saveDatabase(db);
  res.json({ ok: true });
});

// Announcements
app.get('/api/announcements', requireAuth(), (req, res) => {
  const db = getDatabase();
  res.json(db.announcements);
});

app.post('/api/announcements', requireAuth('admin'), (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'Título y contenido requeridos' });
  }
  const db = getDatabase();
  const announcement = {
    id: generateId('ann'),
    title,
    body,
    createdAt: new Date().toISOString(),
    createdBy: req.session.userId,
  };
  db.announcements.push(announcement);
  notifyResidents(db, {
    title: 'Nuevo anuncio',
    body: title,
    category: 'announcements',
    entityType: 'announcement',
    entityId: announcement.id,
    linkTab: 'res-announcements',
  }, { excludeUserId: req.session.userId });
  notifyStaff(db, {
    title: 'Nuevo anuncio',
    body: title,
    category: 'announcements',
    entityType: 'announcement',
    entityId: announcement.id,
    linkTab: 'sec-announcements',
  }, { excludeUserId: req.session.userId });
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'announcements',
    entityType: 'announcement',
    entityId: announcement.id,
    details: `Anuncio: ${title}`,
  });
  res.status(201).json(announcement);
});

app.patch('/api/announcements/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const ann = db.announcements.find((a) => a.id === req.params.id);
  if (!ann) return res.status(404).json({ error: 'Anuncio no encontrado' });
  if (req.body.title) ann.title = req.body.title;
  if (req.body.body) ann.body = req.body.body;
  saveDatabase(db);
  res.json(ann);
});

app.delete('/api/announcements/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.announcements.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Anuncio no encontrado' });
  db.announcements.splice(idx, 1);
  saveDatabase(db);
  res.json({ ok: true });
});

// Payments
app.get('/api/payments', requireAuth(), (req, res) => {
  const db = getDatabase();
  let payments = db.payments;
  if (req.session.role === 'resident') {
    const unit = getResidentUnit(req.session);
    payments = payments.filter((p) => p.unit === unit);
  }
  res.json(payments);
});

app.post('/api/payments', requireAuth('admin'), (req, res) => {
  const { unit, concept, amount, dueDate, residentId } = req.body || {};
  if (!unit || !concept || amount == null || !dueDate) {
    return res.status(400).json({ error: 'Unidad, concepto, monto y fecha requeridos' });
  }
  const db = getDatabase();
  const payment = {
    id: generateId('pay'),
    unit,
    concept,
    amount: Number(amount),
    status: 'pendiente',
    dueDate,
    residentId: residentId || null,
  };
  db.payments.push(payment);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'payments',
    entityType: 'payment',
    entityId: payment.id,
    details: `Pago: ${concept} - ${unit}`,
  });
  res.status(201).json(payment);
});

app.patch('/api/payments/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const payment = db.payments.find((p) => p.id === req.params.id);
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
  if (req.body.status) {
    payment.status = req.body.status;
    if (req.body.status === 'pagado') {
      payment.paidAt = new Date().toISOString();
    }
  }
  if (req.body.concept) payment.concept = req.body.concept;
  if (req.body.amount != null) payment.amount = Number(req.body.amount);
  saveDatabase(db);
  res.json(payment);
});

app.delete('/api/payments/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.payments.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Pago no encontrado' });
  db.payments.splice(idx, 1);
  saveDatabase(db);
  res.json({ ok: true });
});

// Staff
// Staff
app.get('/api/staff/options', requireAuth(['admin', 'staff']), (req, res) => {
  const db = getDatabase();
  res.json(
    db.staff
      .filter((s) => s.active !== false)
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  );
});

app.get('/api/staff', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  res.json(db.staff.map(publicStaff));
});

app.post('/api/staff', requireAuth('admin'), (req, res) => {
  const { name, username, phone, position, password } = req.body || {};
  if (!name || !username || !phone || !password) {
    return res.status(400).json({ error: 'Nombre, usuario, teléfono y contraseña requeridos' });
  }
  const db = getDatabase();
  if (db.staff.some((s) => s.username === username)) {
    return res.status(409).json({ error: 'El usuario ya existe' });
  }
  const member = {
    id: generateId('staff'),
    name,
    username,
    phone,
    position: position || '',
    passwordHash: hashPassword(password),
    active: true,
  };
  db.staff.push(member);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'staff',
    entityType: 'staff',
    entityId: member.id,
    details: `Personal creado: ${name}`,
  });
  res.status(201).json(publicStaff(member));
});

app.patch('/api/staff/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.staff.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Personal no encontrado' });
  const allowed = ['name', 'username', 'phone', 'position'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.staff[idx][key] = req.body[key];
  }
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'update',
    category: 'staff',
    entityType: 'staff',
    entityId: req.params.id,
    details: `Personal actualizado: ${db.staff[idx].name}`,
  });
  res.json(publicStaff(db.staff[idx]));
});

app.patch('/api/staff/:id/status', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const member = db.staff.find((s) => s.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Personal no encontrado' });
  member.active = req.body.active !== false;
  if (!member.active) destroySessionsForUser(member.id);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'update',
    category: 'staff',
    entityType: 'staff',
    entityId: member.id,
    details: `Personal ${member.active ? 'habilitado' : 'deshabilitado'}: ${member.name}`,
  });
  res.json(publicStaff(member));
});

app.patch('/api/staff/:id/password', requireAuth('admin'), (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
  const db = getDatabase();
  const member = db.staff.find((s) => s.id === req.params.id);
  if (!member) return res.status(404).json({ error: 'Personal no encontrado' });
  member.passwordHash = hashPassword(password);
  saveDatabase(db);
  destroySessionsForUser(member.id);
  res.json({ ok: true });
});

app.delete('/api/staff/:id', requireAuth('admin'), requireSuperAdmin(), (req, res) => {
  const db = getDatabase();
  const idx = db.staff.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Personal no encontrado' });
  const removed = db.staff.splice(idx, 1)[0];
  destroySessionsForUser(removed.id);
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'delete',
    category: 'staff',
    entityType: 'staff',
    entityId: removed.id,
    details: `Personal eliminado: ${removed.name}`,
  });
  res.json({ ok: true });
});

// Correspondence
function publicCorrespondenceItem(item, db, viewerRole) {
  const { photo, signature, ...rest } = item;
  const canSeeSignature = viewerRole === 'admin' || viewerRole === 'resident';
  const result = {
    ...rest,
    hasPhoto: Boolean(photo),
    hasSignature: canSeeSignature ? Boolean(signature) : false,
  };
  if (!result.receivedByStaffName && result.receivedBy) {
    const receiver = db.staff.find((s) => s.id === result.receivedBy);
    if (receiver) result.receivedByStaffName = receiver.name;
  }
  return result;
}

function sendDataImage(res, dataUrl, notFoundMsg) {
  if (!dataUrl) return res.status(404).json({ error: notFoundMsg });
  const match = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!match) return res.status(404).json({ error: 'Formato de imagen inválido' });
  const buffer = Buffer.from(match[2], 'base64');
  res.set('Content-Type', match[1]);
  return res.send(buffer);
}

function isValidSignatureDataUrl(signature) {
  if (!signature || typeof signature !== 'string') return false;
  const match = signature.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return false;
  // A real hand-drawn signature is larger than a 1x1 blank PNG
  return match[2].length >= 200;
}

app.get('/api/correspondence', requireAuth(['admin', 'staff', 'resident']), (req, res) => {
  const db = getDatabase();
  let items = db.correspondence;
  if (req.session.role === 'resident') {
    items = items.filter((c) => c.residentId === req.session.userId);
  }
  res.json(items.map((c) => publicCorrespondenceItem(c, db, req.session.role)));
});

app.post('/api/correspondence', requireAuth('staff'), (req, res) => {
  const { residentId, description, photo } = req.body || {};
  if (!residentId || !description) {
    return res.status(400).json({ error: 'Residente y descripción requeridos' });
  }
  const db = getDatabase();
  const resident = db.residents.find((r) => r.id === residentId);
  if (!resident) return res.status(404).json({ error: 'Residente no encontrado' });
  const item = {
    id: generateId('corr'),
    residentId,
    unit: resident.unit,
    residentName: resident.name,
    description,
    photo: photo || null,
    status: 'recibido',
    receivedAt: new Date().toISOString(),
    receivedBy: req.session.userId,
    receivedByStaffName: req.session.name,
  };
  db.correspondence.push(item);
  notifyAdmins(db, {
    title: 'Correspondencia recibida',
    body: `Unidad ${resident.unit} — ${resident.name}: ${description}`,
    category: 'correspondence',
    entityType: 'correspondence',
    entityId: item.id,
    linkTab: 'correspondence-admin',
  }, { excludeUserId: req.session.userId });
  if (resident.id) {
    notifyUser(db, resident.id, 'resident', {
      title: 'Tienes correspondencia',
      body: description,
      category: 'correspondence',
      entityType: 'correspondence',
      entityId: item.id,
      linkTab: 'res-correspondence',
    });
  }
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'create',
    category: 'correspondence',
    entityType: 'correspondence',
    entityId: item.id,
    details: `Correspondencia recibida: ${resident.unit} - ${description}`,
  });
  res.status(201).json(publicCorrespondenceItem(item, db, req.session.role));
});

app.patch('/api/correspondence/:id/deliver', requireAuth('staff'), (req, res) => {
  const { recipientName, signature } = req.body || {};
  if (!recipientName || !recipientName.trim()) {
    return res.status(400).json({ error: 'Nombre de quien recibe requerido' });
  }
  if (!isValidSignatureDataUrl(signature)) {
    return res.status(400).json({ error: 'Firma del residente requerida' });
  }

  const db = getDatabase();
  const item = db.correspondence.find((c) => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Correspondencia no encontrada' });
  if (item.status === 'entregado') {
    return res.status(409).json({ error: 'Esta correspondencia ya fue entregada' });
  }

  const actor = findUserById(req.session.userId, 'staff');
  if (!actor || actor.active === false) {
    return res.status(401).json({ error: 'Sesión de vigilante no válida' });
  }
  if (!isGuardOnActiveDuty(db.guardShiftPeriods, actor.name)) {
    const onDuty = getOnDutyGuard(db.guardShiftPeriods);
    const who = onDuty?.guardName ? ` Ahora está de turno: ${onDuty.guardName}.` : '';
    return res.status(400).json({
      error: `No estás en turno en este momento.${who}`,
    });
  }

  const staffMember = findStaffByGuardName(db.staff, actor.name) || actor;

  item.status = 'entregado';
  item.recipientName = recipientName.trim();
  item.deliveredAt = new Date().toISOString();
  item.deliveredByStaffId = staffMember.id;
  item.deliveredByStaffName = staffMember.name;
  item.signature = signature;
  notifyAdmins(db, {
    title: 'Correspondencia entregada',
    body: `Unidad ${item.unit} — entregado a ${item.recipientName}`,
    category: 'correspondence',
    entityType: 'correspondence',
    entityId: item.id,
    linkTab: 'correspondence-admin',
  }, { excludeUserId: req.session.userId });
  if (item.residentId) {
    notifyUser(db, item.residentId, 'resident', {
      title: 'Correspondencia entregada',
      body: `Entregado a ${item.recipientName}`,
      category: 'correspondence',
      entityType: 'correspondence',
      entityId: item.id,
      linkTab: 'res-correspondence',
    });
  }
  saveDatabase(db);

  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'deliver',
    category: 'correspondence',
    entityType: 'correspondence',
    entityId: item.id,
    details: `Entregado a ${item.recipientName} por ${staffMember.name}`,
  });

  res.json(publicCorrespondenceItem(item, db, req.session.role));
});

app.delete('/api/correspondence', requireAuth('admin'), requireSuperAdmin(), (req, res) => {
  const db = getDatabase();
  const count = db.correspondence.length;
  db.correspondence = [];
  saveDatabase(db);
  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'delete',
    category: 'correspondence',
    entityType: 'correspondence',
    entityId: 'all',
    details: `Correspondencia limpiada (${count} registros)`,
  });
  res.json({ ok: true, removed: count });
});

app.get('/api/correspondence/:id/photo', requireAuth(['admin', 'staff', 'resident']), (req, res) => {
  const db = getDatabase();
  const item = db.correspondence.find((c) => c.id === req.params.id);
  if (!item || !item.photo) {
    return res.status(404).json({ error: 'Foto no encontrada' });
  }
  if (req.session.role === 'resident' && item.residentId !== req.session.userId) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return sendDataImage(res, item.photo, 'Foto no encontrada');
});

app.get('/api/correspondence/:id/signature', requireAuth(['admin', 'resident']), (req, res) => {
  const db = getDatabase();
  const item = db.correspondence.find((c) => c.id === req.params.id);
  if (!item || !item.signature) {
    return res.status(404).json({ error: 'Firma no encontrada' });
  }
  if (req.session.role === 'resident' && item.residentId !== req.session.userId) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  return sendDataImage(res, item.signature, 'Firma no encontrada');
});

// Audit
app.get('/api/audit', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  let logs = filterAuditLogsForViewer([...db.auditLog], db, req.session);
  if (req.query.actorId) {
    logs = logs.filter((l) => l.actorId === req.query.actorId);
  }
  if (req.query.category) {
    logs = logs.filter((l) => l.category === req.query.category);
  }
  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    logs = logs.filter(
      (l) =>
        (l.details && l.details.toLowerCase().includes(q)) ||
        (l.actorName && l.actorName.toLowerCase().includes(q)) ||
        (l.action && l.action.toLowerCase().includes(q))
    );
  }
  logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(logs.map((l) => enrichAuditLog(l, db)));
});

// Guard shifts
app.get('/api/guard-shifts/on-duty', requireAuth(['admin', 'staff']), (req, res) => {
  const db = getDatabase();
  const onDuty = getOnDutyGuard(db.guardShiftPeriods);
  if (!onDuty) {
    return res.status(404).json({ error: 'No hay vigilante en turno en este momento' });
  }
  const staffMember = findStaffByGuardName(db.staff, onDuty.guardName);
  if (!staffMember) {
    return res.status(404).json({
      error: `El vigilante en turno (${onDuty.guardName}) no está registrado en el sistema`,
    });
  }
  res.json({
    staffId: staffMember.id,
    staffName: staffMember.name,
    shiftLabel: onDuty.shiftLabel,
    schedule: onDuty.schedule,
  });
});

app.get('/api/guard-shifts', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const periods = [...db.guardShiftPeriods].sort(
    (a, b) => b.startDate.localeCompare(a.startDate) || b.createdAt.localeCompare(a.createdAt)
  );
  res.json({
    periods,
    suggestedStartDate: getSuggestedStartDate(db.guardShiftPeriods),
    guardShiftAnchor: db.guardShiftAnchor,
  });
});

app.post('/api/guard-shifts/generate', requireAuth('admin'), (req, res) => {
  const startDate = req.body.startDate || formatLocalDate(new Date());
  const days = Number(req.body.days) || 14;
  if (!startDate || days < 1) {
    return res.status(400).json({ error: 'Fecha de inicio y cantidad de días requeridos' });
  }

  const db = getDatabase();
  const endDate = periodEndDate(startDate, days);

  const overlaps = db.guardShiftPeriods.some((p) =>
    periodsOverlap(p.startDate, p.endDate, startDate, endDate)
  );
  if (overlaps) {
    return res.status(409).json({
      error: `Ya existe una malla entre ${startDate} y ${endDate}. Elija otras fechas o limpie los turnos.`,
    });
  }

  if (!db.guardShiftAnchor) {
    db.guardShiftAnchor = startDate;
  }

  const startDayIndex = getShiftDayIndex(db.guardShiftAnchor, startDate);
  if (startDayIndex < 0) {
    return res.status(400).json({
      error: 'La fecha de inicio no puede ser anterior al inicio de la rotación actual.',
    });
  }

  const shifts = generateGuardShiftSchedule(startDate, days, startDayIndex);
  const period = createGuardShiftPeriod(shifts, startDate, endDate);
  db.guardShiftPeriods.push(period);
  saveDatabase(db);

  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'generate',
    category: 'guardShifts',
    entityType: 'guardShift',
    entityId: period.id,
    details: `Malla generada: ${startDate} a ${endDate} (${days} días)`,
  });
  res.status(201).json(period);
});

app.get('/api/guard-shifts.csv', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const periodId = req.query.periodId;
  if (!periodId) {
    return res.status(400).json({ error: 'periodId requerido' });
  }
  const period = db.guardShiftPeriods.find((p) => p.id === periodId);
  if (!period) return res.status(404).json({ error: 'Malla no encontrada' });

  const csv = guardShiftsToCsv(period.shifts);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set(
    'Content-Disposition',
    `attachment; filename="turnos-${period.startDate}_${period.endDate}.csv"`
  );
  res.send(csv);
});

app.delete('/api/guard-shifts/:id', requireAuth('admin'), (req, res) => {
  const db = getDatabase();
  const idx = db.guardShiftPeriods.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Malla no encontrada' });

  const removed = db.guardShiftPeriods.splice(idx, 1)[0];
  if (db.guardShiftPeriods.length === 0) {
    db.guardShiftAnchor = null;
  }
  saveDatabase(db);

  appendAudit({
    actorId: req.session.userId,
    actorName: req.session.name,
    actorRole: req.session.role,
    action: 'delete',
    category: 'guardShifts',
    entityType: 'guardShift',
    entityId: removed.id,
    details: `Malla eliminada: ${removed.startDate} a ${removed.endDate}`,
  });
  res.json({ ok: true, period: removed });
});

module.exports = app;
