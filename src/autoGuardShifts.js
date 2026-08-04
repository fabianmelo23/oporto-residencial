const {
  getDatabase,
  saveDatabase,
  generateId,
  ensureNextMonthGuardShiftPeriod,
} = require('./store');
const { notifyAdmins } = require('./notifications');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // cada hora

function runAutoGuardShiftEnsure(now = new Date()) {
  const db = getDatabase();
  const result = ensureNextMonthGuardShiftPeriod(db, now);

  if (result.action !== 'created' || !result.period) {
    return result;
  }

  if (!Array.isArray(db.auditLog)) db.auditLog = [];
  db.auditLog.push({
    id: generateId('audit'),
    timestamp: new Date().toISOString(),
    actorId: 'system',
    actorName: 'Sistema',
    actorRole: 'admin',
    action: 'auto_generate',
    category: 'guardShifts',
    entityType: 'guardShift',
    entityId: result.period.id,
    details: `Malla auto-generada del mes siguiente: ${result.startDate} a ${result.endDate} (${result.days} días)`,
  });

  notifyAdmins(db, {
    title: 'Malla de turnos generada automáticamente',
    body: `Se generó la malla del ${result.startDate} al ${result.endDate} porque faltaba poco para terminar el mes.`,
    category: 'guardShifts',
    entityType: 'guardShift',
    entityId: result.period.id,
    linkTab: 'guard-shifts',
  });

  saveDatabase(db);
  return result;
}

function startAutoGuardShiftScheduler() {
  const tick = () => {
    try {
      const result = runAutoGuardShiftEnsure();
      if (result.action === 'created') {
        console.log(
          `[turnos] Malla auto-generada: ${result.startDate} → ${result.endDate} (${result.days} días)`
        );
      }
    } catch (err) {
      console.error('[turnos] Error al verificar malla del mes siguiente:', err.message || err);
    }
  };

  // Al arrancar y luego cada hora
  tick();
  return setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = {
  runAutoGuardShiftEnsure,
  startAutoGuardShiftScheduler,
  CHECK_INTERVAL_MS,
};
