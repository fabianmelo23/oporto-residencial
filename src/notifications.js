const { generateId } = require('./store');

const MAX_NOTIFICATIONS = 400;

function ensureNotifications(db) {
  if (!Array.isArray(db.notifications)) db.notifications = [];
}

function pushNotification(db, payload) {
  ensureNotifications(db);
  const item = {
    id: generateId('notif'),
    userId: payload.userId,
    userRole: payload.userRole,
    title: payload.title,
    body: payload.body || '',
    category: payload.category || 'general',
    entityType: payload.entityType || null,
    entityId: payload.entityId || null,
    linkTab: payload.linkTab || null,
    read: false,
    createdAt: new Date().toISOString(),
  };
  db.notifications.unshift(item);
  if (db.notifications.length > MAX_NOTIFICATIONS) {
    db.notifications.length = MAX_NOTIFICATIONS;
  }
  return item;
}

function notifyUsers(db, users, payload, options = {}) {
  const excludeUserId = options.excludeUserId || null;
  (users || []).forEach((user) => {
    if (!user || !user.id) return;
    if (excludeUserId && user.id === excludeUserId) return;
    if (user.active === false) return;
    pushNotification(db, {
      ...payload,
      userId: user.id,
      userRole: user.role,
    });
  });
}

function notifyAdmins(db, payload, options = {}) {
  const users = (db.admins || []).map((a) => ({ ...a, role: 'admin' }));
  notifyUsers(db, users, payload, options);
}

function notifyStaff(db, payload, options = {}) {
  const users = (db.staff || [])
    .filter((s) => s.active !== false)
    .map((s) => ({ ...s, role: 'staff' }));
  notifyUsers(db, users, payload, options);
}

function notifyResidents(db, payload, options = {}) {
  const users = (db.residents || [])
    .filter((r) => r.active !== false)
    .map((r) => ({ ...r, role: 'resident' }));
  notifyUsers(db, users, payload, options);
}

function notifyUser(db, userId, userRole, payload) {
  if (!userId) return;
  pushNotification(db, {
    ...payload,
    userId,
    userRole,
  });
}

function getUserNotifications(db, userId, userRole) {
  ensureNotifications(db);
  return db.notifications
    .filter((n) => n.userId === userId && n.userRole === userRole)
    .slice(0, 50);
}

function getUnreadCount(db, userId, userRole) {
  ensureNotifications(db);
  return db.notifications.filter(
    (n) => n.userId === userId && n.userRole === userRole && !n.read
  ).length;
}

module.exports = {
  pushNotification,
  notifyAdmins,
  notifyStaff,
  notifyResidents,
  notifyUser,
  getUserNotifications,
  getUnreadCount,
  ensureNotifications,
};
