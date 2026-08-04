const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, '..', 'data', 'database.json');
const DEFAULT_DB_FILE = path.join(__dirname, '..', 'data', 'database.local.json');

function getDbPath() {
  // Prefer Railway volume FIRST. A mis-set DATABASE_FILE like ./data/database.wipe.json
  // must never override the persistent mount, or every redeploy wipes production data.
  const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volumeMount) {
    return path.join(volumeMount, 'database.json');
  }

  const envPath = process.env.DATABASE_FILE;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  }

  return DEFAULT_DB_FILE;
}

function isRailwayRuntime() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT
    || process.env.RAILWAY_PROJECT_ID
    || process.env.RAILWAY_SERVICE_ID
  );
}

function warnIfDatabaseNotPersistent(dbPath) {
  if (!isRailwayRuntime()) return;
  const onVolume = Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH)
    && dbPath.startsWith(process.env.RAILWAY_VOLUME_MOUNT_PATH);
  const absoluteCustom = process.env.DATABASE_FILE
    && path.isAbsolute(process.env.DATABASE_FILE)
    && !process.env.DATABASE_FILE.includes('/app/')
    && !process.env.DATABASE_FILE.startsWith('./');
  if (onVolume || absoluteCustom) return;

  console.error(
    '[CRITICO] Railway está usando almacenamiento efímero. '
    + 'Los residentes, visitas, reservas y demás datos se BORRARÁN en el próximo deploy. '
    + 'Crea un Volume en Railway (mount path /data) y define DATABASE_FILE=/data/database.json.'
  );
}

function normalizeDatabase(db) {
  const collections = [
    'community',
    'admins',
    'residents',
    'staff',
    'visits',
    'reservations',
    'maintenance',
    'announcements',
    'payments',
    'correspondence',
    'auditLog',
    'notifications',
    'guardShifts',
    'guardShiftPeriods',
  ];

  for (const key of collections) {
    if (key === 'community') {
      if (!db.community || typeof db.community !== 'object') {
        db.community = { name: 'Conjunto Residencial', address: '' };
      }
    } else if (!Array.isArray(db[key])) {
      db[key] = [];
    }
  }

  if (!db.guardShiftPeriods) db.guardShiftPeriods = [];

  if (db.guardShifts && db.guardShifts.length > 0 && db.guardShiftPeriods.length === 0) {
    const dates = db.guardShifts.map((s) => s.date).sort();
    db.guardShiftPeriods.push({
      id: `gperiod_migrated_${Date.now()}`,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      createdAt: new Date().toISOString(),
      shifts: db.guardShifts,
    });
    db.guardShifts = [];
  }

  if (db.guardShiftAnchor === undefined) {
    db.guardShiftAnchor =
      db.guardShiftPeriods.length > 0 ? db.guardShiftPeriods[0].startDate : null;
  }

  return db;
}

function ensureDatabase() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(dbPath)) {
    if (!fs.existsSync(SEED_FILE)) {
      throw new Error(`Archivo semilla no encontrado: ${SEED_FILE}`);
    }
    fs.copyFileSync(SEED_FILE, dbPath);
  }

  return dbPath;
}

let cachedDb = null;
let dbPath = null;
let dataRevision = 0;
const changeListeners = new Set();

function getDataRevision() {
  return dataRevision;
}

function subscribeDataChanges(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyDataChange() {
  dataRevision += 1;
  const payload = { revision: dataRevision, at: new Date().toISOString() };
  for (const listener of changeListeners) {
    try {
      listener(payload);
    } catch {
      /* ignore listener errors */
    }
  }
  return payload;
}

function loadDatabase() {
  dbPath = ensureDatabase();
  warnIfDatabaseNotPersistent(dbPath);
  console.log(`[db] Usando archivo: ${dbPath}`);
  const raw = fs.readFileSync(dbPath, 'utf8');
  cachedDb = normalizeDatabase(JSON.parse(raw));
  return cachedDb;
}

function saveDatabase(db) {
  if (!dbPath) {
    dbPath = ensureDatabase();
  }
  cachedDb = normalizeDatabase(db);
  fs.writeFileSync(dbPath, JSON.stringify(cachedDb, null, 2), 'utf8');
  notifyDataChange();
  return cachedDb;
}

function getDatabase() {
  if (!cachedDb) {
    return loadDatabase();
  }
  return cachedDb;
}

function resetCache() {
  cachedDb = null;
  dbPath = null;
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addLocalDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysBetween(startDateStr, endDateStr) {
  const start = parseLocalDate(startDateStr);
  const end = parseLocalDate(endDateStr);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function periodEndDate(startDateStr, days) {
  return formatLocalDate(addLocalDays(parseLocalDate(startDateStr), days - 1));
}

function periodsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function getSuggestedStartDate(periods) {
  if (!periods.length) return null;
  const sorted = [...periods].sort((a, b) => a.endDate.localeCompare(b.endDate));
  const last = sorted[sorted.length - 1];
  return formatLocalDate(addLocalDays(parseLocalDate(last.endDate), 1));
}

function getDaysLeftInMonth(now = new Date()) {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return lastDay - now.getDate();
}

function getNextCalendarMonthRange(now = new Date()) {
  const firstNext = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const startDate = formatLocalDate(firstNext);
  const endDate = formatLocalDate(new Date(firstNext.getFullYear(), firstNext.getMonth() + 1, 0));
  const days = daysBetween(startDate, endDate) + 1;
  return {
    startDate,
    endDate,
    days,
    year: firstNext.getFullYear(),
    month: firstNext.getMonth() + 1,
  };
}

function periodCoversRange(periods, startDate, endDate) {
  return (periods || []).some((p) =>
    periodsOverlap(p.startDate, p.endDate, startDate, endDate)
  );
}

/**
 * If there is 1 day or less left in the month, ensure the next calendar month
 * has a guard-shift period. Idempotent: does nothing if already covered.
 * Mutates `db` but does not save.
 */
function ensureNextMonthGuardShiftPeriod(db, now = new Date()) {
  const daysLeft = getDaysLeftInMonth(now);
  if (daysLeft > 1) {
    return { action: 'skipped', reason: 'not_near_month_end', daysLeft };
  }

  const periods = db.guardShiftPeriods || [];
  if (!periods.length && !db.guardShiftAnchor) {
    return { action: 'skipped', reason: 'no_existing_schedule', daysLeft };
  }

  const next = getNextCalendarMonthRange(now);
  if (periodCoversRange(periods, next.startDate, next.endDate)) {
    return {
      action: 'skipped',
      reason: 'already_exists',
      daysLeft,
      startDate: next.startDate,
      endDate: next.endDate,
    };
  }

  if (!db.guardShiftAnchor) {
    const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
    db.guardShiftAnchor = sorted[0] ? sorted[0].startDate : next.startDate;
  }

  const startDayIndex = getShiftDayIndex(db.guardShiftAnchor, next.startDate);
  if (startDayIndex < 0) {
    return {
      action: 'skipped',
      reason: 'before_anchor',
      daysLeft,
      startDate: next.startDate,
      endDate: next.endDate,
    };
  }

  const overlaps = periods.some((p) =>
    periodsOverlap(p.startDate, p.endDate, next.startDate, next.endDate)
  );
  if (overlaps) {
    return {
      action: 'skipped',
      reason: 'already_exists',
      daysLeft,
      startDate: next.startDate,
      endDate: next.endDate,
    };
  }

  const shifts = generateGuardShiftSchedule(next.startDate, next.days, startDayIndex);
  const period = createGuardShiftPeriod(shifts, next.startDate, next.endDate);
  if (!Array.isArray(db.guardShiftPeriods)) db.guardShiftPeriods = [];
  db.guardShiftPeriods.push(period);

  return {
    action: 'created',
    reason: 'generated',
    daysLeft,
    startDate: next.startDate,
    endDate: next.endDate,
    days: next.days,
    period,
  };
}

function getShiftDayIndex(anchorDate, targetDate) {
  if (!anchorDate) return 0;
  return daysBetween(anchorDate, targetDate);
}

function createGuardShiftPeriod(shifts, startDate, endDate) {
  return {
    id: generateId('gperiod'),
    startDate,
    endDate,
    createdAt: new Date().toISOString(),
    shifts,
  };
}

function shiftDateRange(shifts) {
  const dates = shifts.map((s) => s.date).sort();
  return { startDate: dates[0], endDate: dates[dates.length - 1] };
}

function normalizeGuardName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function guardNamesMatch(a, b) {
  return normalizeGuardName(a) === normalizeGuardName(b);
}

function isShiftActiveAt(shift, now = new Date()) {
  if (!shift || shift.type === 'rest') return false;

  const today = formatLocalDate(now);
  const yesterday = formatLocalDate(addLocalDays(parseLocalDate(today), -1));

  if (shift.type === 'day') {
    if (shift.date !== today) return false;
    const start = parseTimeOnDate(shift.date, shift.startTime);
    const end = parseTimeOnDate(shift.date, shift.endTime);
    return now >= start && now < end;
  }

  if (shift.type === 'night') {
    if (shift.date === today) {
      const start = parseTimeOnDate(shift.date, shift.startTime);
      if (now >= start) return true;
    }
    if (shift.date === yesterday && (shift.endDate === today || !shift.endDate)) {
      const end = parseTimeOnDate(shift.endDate || today, shift.endTime);
      if (now < end) return true;
    }
    return false;
  }

  return false;
}

function getOnDutyGuard(periods, now = new Date()) {
  const active = getAllShiftsFromPeriods(periods).filter((s) => isShiftActiveAt(s, now));
  const shift = active.find((s) => s.type !== 'rest');
  if (!shift) return null;
  return {
    guardName: shift.guardName,
    ...buildShiftInfo(shift),
  };
}

function getShiftWindow(shift) {
  if (!shift || shift.type === 'rest') return null;
  const start = parseTimeOnDate(shift.date, shift.startTime);
  const end =
    shift.type === 'night'
      ? parseTimeOnDate(shift.endDate || shift.date, shift.endTime)
      : parseTimeOnDate(shift.date, shift.endTime);
  return { start, end };
}

function isGuardOnActiveDuty(periods, guardName, now = new Date()) {
  if (!(periods || []).length || !guardName) return false;
  return getAllShiftsFromPeriods(periods).some(
    (s) => guardNamesMatch(s.guardName, guardName) && s.type !== 'rest' && isShiftActiveAt(s, now)
  );
}

function getNextDutyShiftForGuard(periods, guardName, now = new Date()) {
  if (!(periods || []).length || !guardName) return null;
  const upcoming = getAllShiftsFromPeriods(periods)
    .filter((s) => guardNamesMatch(s.guardName, guardName) && s.type !== 'rest')
    .map((s) => {
      const window = getShiftWindow(s);
      if (!window) return null;
      return { shift: s, start: window.start, end: window.end };
    })
    .filter((c) => c && c.end > now)
    .sort((a, b) => a.start - b.start);

  const next = upcoming.find((c) => c.start > now) || upcoming[0] || null;
  if (!next) return null;
  return {
    ...buildShiftInfo(next.shift),
    startsAt: next.start.toISOString(),
    endsAt: next.end.toISOString(),
    startDateTime: next.start,
  };
}

function formatStaffDutyDeniedMessage(nextDuty) {
  if (!nextDuty || !nextDuty.startDateTime) {
    return 'No estás en turno en este momento y no tienes próximos turnos en la malla. Contacta a administración.';
  }
  const when = nextDuty.startDateTime.toLocaleString('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const label = nextDuty.shiftLabel || (nextDuty.type === 'night' ? 'nocturno' : 'diurno');
  return `No estás en turno en este momento. Puedes iniciar sesión el ${when} (turno ${label}).`;
}

function evaluateStaffLoginAccess(periods, guardName, now = new Date()) {
  const hasSchedule = Array.isArray(periods) && periods.length > 0;
  if (!hasSchedule) {
    return { allowed: true, reason: 'no_schedule' };
  }
  if (isGuardOnActiveDuty(periods, guardName, now)) {
    return { allowed: true, reason: 'on_duty' };
  }
  const nextDuty = getNextDutyShiftForGuard(periods, guardName, now);
  return {
    allowed: false,
    reason: 'off_duty',
    nextDuty,
    message: formatStaffDutyDeniedMessage(nextDuty),
  };
}

function findStaffByGuardName(staffList, guardName) {
  return (staffList || []).find((s) => s.active !== false && guardNamesMatch(s.name, guardName)) || null;
}

function parseTimeOnDate(dateStr, timeStr) {
  const [h, m] = (timeStr || '00:00').split(':').map(Number);
  const d = parseLocalDate(dateStr);
  d.setHours(h, m, 0, 0);
  return d;
}

function buildShiftInfo(shift) {
  if (shift.type === 'rest') {
    return {
      shiftLabel: shift.shiftLabel,
      type: 'rest',
      schedule: 'Día de descanso',
    };
  }
  let schedule;
  if (shift.type === 'night' && shift.endDate && shift.endDate !== shift.date) {
    schedule = `${shift.startTime} a ${shift.endTime} (${shift.endDate})`;
  } else {
    schedule = `${shift.startTime} a ${shift.endTime}`;
  }
  return {
    shiftLabel: shift.shiftLabel,
    type: shift.type,
    schedule,
    startTime: shift.startTime,
    endTime: shift.endTime,
    endDate: shift.endDate || null,
    date: shift.date,
  };
}

function getAllShiftsFromPeriods(periods) {
  return (periods || []).flatMap((p) => p.shifts || []);
}

function getCurrentGuardShift(periods, guardName, now = new Date()) {
  const today = formatLocalDate(now);
  const yesterday = formatLocalDate(addLocalDays(parseLocalDate(today), -1));
  const mine = getAllShiftsFromPeriods(periods).filter((s) =>
    guardNamesMatch(s.guardName, guardName)
  );

  if (!mine.length) return null;

  // Turno nocturno de ayer que aún está en curso (antes de las 07:00)
  const overnight = mine.find(
    (s) => s.type === 'night' && s.date === yesterday && (s.endDate === today || !s.endDate)
  );
  if (overnight) {
    const end = parseTimeOnDate(overnight.endDate || today, overnight.endTime);
    if (now < end) return buildShiftInfo(overnight);
  }

  // Turno programado para hoy en la malla (sin importar la hora actual)
  const todayShift = mine.find((s) => s.date === today);
  if (todayShift) return buildShiftInfo(todayShift);

  return null;
}

function shiftTypeLabel(type) {
  if (type === 'day') return 'Día';
  if (type === 'night') return 'Noche';
  return 'Descanso';
}

const SHIFT_PHASES = ['day', 'night', 'rest'];

const SHIFT_LABELS = {
  day: ['1 diurno', '2 diurno'],
  night: ['1 nocturno', '2 nocturno'],
  rest: ['1 descanso', '2 descanso'],
};

// Cada vigilante inicia en una fase distinta del ciclo 2+2+2
const DEFAULT_GUARDS = [
  { name: 'Fabián Melo', startPhase: 1 },
  { name: 'Jorge Bernal', startPhase: 2 },
  { name: 'Yeison Obando', startPhase: 0 },
];

function getGuardShiftStatus(guard, dayIndex) {
  const phaseIndex = (guard.startPhase + Math.floor(dayIndex / 2)) % 3;
  const stintIndex = dayIndex % 2;
  const type = SHIFT_PHASES[phaseIndex];
  return {
    type,
    shiftLabel: SHIFT_LABELS[type][stintIndex],
  };
}

function inferShiftTypeFromLabel(label) {
  const raw = (label || '').toLowerCase();
  if (raw.includes('descanso') || raw === 'rest') return 'rest';
  if (raw.includes('nocturn') || raw === 'noche' || raw === 'night') return 'night';
  if (raw.includes('diurn') || raw === 'día' || raw === 'dia' || raw === 'day') return 'day';
  return 'day';
}

function generateGuardShiftSchedule(startDate, days = 14, startDayIndex = 0) {
  const start = parseLocalDate(startDate);
  const shifts = [];

  for (let d = 0; d < days; d++) {
    const dayIndex = startDayIndex + d;
    const date = addLocalDays(start, d);
    const dateStr = formatLocalDate(date);
    const nextDateStr = formatLocalDate(addLocalDays(date, 1));

    const byRole = { day: null, night: null, rest: null };
    for (const guard of DEFAULT_GUARDS) {
      const status = getGuardShiftStatus(guard, dayIndex);
      byRole[status.type] = { guard, ...status };
    }

    shifts.push({
      id: generateId('shift'),
      date: dateStr,
      type: 'day',
      guardName: byRole.day.guard.name,
      shiftLabel: byRole.day.shiftLabel,
      startTime: '07:00',
      endTime: '18:00',
      hours: 11,
    });

    shifts.push({
      id: generateId('shift'),
      date: dateStr,
      type: 'night',
      guardName: byRole.night.guard.name,
      shiftLabel: byRole.night.shiftLabel,
      startTime: '18:00',
      endTime: '07:00',
      endDate: nextDateStr,
      hours: 13,
    });

    shifts.push({
      id: generateId('shift'),
      date: dateStr,
      type: 'rest',
      guardName: byRole.rest.guard.name,
      shiftLabel: byRole.rest.shiftLabel,
      startTime: '',
      endTime: '',
      hours: 0,
    });
  }

  return shifts;
}

function guardShiftsToCsv(shifts) {
  const header = 'Fecha,Tipo,Vigilante,Inicio,Fin,Horas';
  const rows = shifts.map((s) => {
    const tipo = s.shiftLabel || shiftTypeLabel(s.type);
    if (s.type === 'rest') {
      return [s.date, tipo, s.guardName, '', '', '0']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',');
    }
    const end = s.endDate ? `${s.endDate} ${s.endTime}` : `${s.date} ${s.endTime}`;
    return [
      s.date,
      tipo,
      s.guardName,
      `${s.date} ${s.startTime}`,
      end,
      s.hours,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',');
  });
  return [header, ...rows].join('\n');
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

function parseGuardShiftsFromCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    throw new Error('El archivo CSV está vacío o no tiene filas de datos');
  }

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (names, fallback) => {
    const idx = header.findIndex((h) => names.some((n) => h.includes(n)));
    return idx >= 0 ? idx : fallback;
  };

  const dateCol = col(['fecha'], 0);
  const typeCol = col(['tipo'], 1);
  const guardCol = col(['vigilante'], 2);
  const startCol = col(['inicio'], 3);
  const endCol = col(['fin'], 4);
  const hoursCol = header.findIndex((h) => h === 'horas' || h.includes('horas'));

  const shifts = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]).map((c) => c.trim());
    if (cols.length < 4) continue;

    const date = cols[dateCol];
    if (!date) continue;

    const tipoLabel = cols[typeCol] || '';
    const type = inferShiftTypeFromLabel(tipoLabel);
    const shiftLabel = tipoLabel || shiftTypeLabel(type);

    const guardName = cols[guardCol];
    if (!guardName) continue;

    if (type === 'rest') {
      shifts.push({
        id: generateId('shift'),
        date,
        type: 'rest',
        guardName,
        shiftLabel,
        startTime: '',
        endTime: '',
        hours: 0,
      });
      continue;
    }

    const startFull = cols[startCol] || '';
    const endFull = cols[endCol] || '';
    const hours =
      hoursCol >= 0 && cols[hoursCol]
        ? Number(cols[hoursCol])
        : type === 'day'
          ? 11
          : 13;

    const startTime = startFull.includes(' ') ? startFull.split(' ').slice(1).join(' ') : type === 'day' ? '07:00' : '18:00';
    const endParts = endFull.split(' ');
    const endTime = endParts.length > 1 ? endParts.slice(1).join(' ') : endFull || (type === 'day' ? '18:00' : '07:00');
    const endDatePart = endParts.length > 1 ? endParts[0] : null;

    const shift = {
      id: generateId('shift'),
      date,
      type,
      guardName,
      shiftLabel,
      startTime,
      endTime,
      hours,
    };

    if (endDatePart && endDatePart !== date) {
      shift.endDate = endDatePart;
    }

    shifts.push(shift);
  }

  if (!shifts.length) {
    throw new Error('No se pudieron leer turnos válidos del CSV');
  }

  return shifts;
}

module.exports = {
  getDbPath,
  isRailwayRuntime,
  warnIfDatabaseNotPersistent,
  normalizeDatabase,
  ensureDatabase,
  loadDatabase,
  saveDatabase,
  getDatabase,
  getDataRevision,
  subscribeDataChanges,
  resetCache,
  generateId,
  DEFAULT_GUARDS,
  generateGuardShiftSchedule,
  guardShiftsToCsv,
  parseGuardShiftsFromCsv,
  parseLocalDate,
  formatLocalDate,
  addLocalDays,
  daysBetween,
  periodEndDate,
  periodsOverlap,
  getSuggestedStartDate,
  getDaysLeftInMonth,
  getNextCalendarMonthRange,
  periodCoversRange,
  ensureNextMonthGuardShiftPeriod,
  getShiftDayIndex,
  createGuardShiftPeriod,
  shiftDateRange,
  shiftTypeLabel,
  getGuardShiftStatus,
  inferShiftTypeFromLabel,
  normalizeGuardName,
  guardNamesMatch,
  getCurrentGuardShift,
  isShiftActiveAt,
  isGuardOnActiveDuty,
  getNextDutyShiftForGuard,
  evaluateStaffLoginAccess,
  formatStaffDutyDeniedMessage,
  getOnDutyGuard,
  findStaffByGuardName,
  buildShiftInfo,
};
