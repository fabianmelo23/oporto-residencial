(function () {
  'use strict';

  let currentUser = null;
  let sessionToken = localStorage.getItem('sessionToken') || '';
  let activeTab = null;
  let activePanelLoader = null;
  let autoRefreshTimer = null;
  let syncEventSource = null;
  let lastDataRevision = null;
  let refreshInFlight = false;
  let reservationCalendar = { year: 0, month: 0, booked: {} };
  let visitCalendar = { year: 0, month: 0, booked: {} };
  const SYNC_POLL_MS = 4000;
  const THEME_KEY = 'oporto-theme';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function getPreferredTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch { /* ignore */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    $$('.theme-toggle').forEach((btn) => {
      btn.setAttribute('aria-label', next === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
      btn.title = next === 'dark' ? 'Tema oscuro · clic para claro' : 'Tema claro · clic para oscuro';
    });
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  function bindThemeToggle() {
    applyTheme(getPreferredTheme());
    ['#theme-toggle', '#theme-toggle-login'].forEach((sel) => {
      const btn = $(sel);
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', toggleTheme);
    });
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    };
    if (sessionToken) opts.headers['x-session-token'] = sessionToken;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      if (data && data.code === 'MUST_CHANGE_PASSWORD' && currentUser) {
        currentUser.mustChangePassword = true;
        openForcePasswordGate();
      }
      if (
        res.status === 401
        && sessionToken
        && path !== '/api/auth/login'
        && path !== '/api/auth/logout'
      ) {
        const msg = (data && data.error) || 'Sesión expirada. Inicia sesión de nuevo.';
        sessionToken = '';
        localStorage.removeItem('sessionToken');
        currentUser = null;
        if (typeof stopSessionLiveSync === 'function') stopSessionLiveSync();
        else stopLiveSync();
        show($('#login-screen'));
        hide($('#app-shell'));
        const errEl = $('#login-error');
        if (errEl) {
          errEl.textContent = msg;
          show(errEl);
        }
      }
      throw new Error((data && data.error) || res.statusText);
    }
    return data;
  }

  function isModalOpen() {
    return ['#deliver-modal', '#reservation-modal', '#visit-modal', '#admin-resident-password-modal'].some((sel) => {
      const el = $(sel);
      return el && !el.classList.contains('hidden');
    });
  }

  function shouldPauseAutoRefresh() {
    if (isModalOpen()) return true;
    const active = document.activeElement;
    if (active && $('#content') && $('#content').contains(active)) {
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    }
    return false;
  }

  function captureLiveUiState() {
    const reservationCal = $('#reservation-calendar-panel');
    if (reservationCal && !reservationCal.classList.contains('hidden') && reservationCalendar.year) {
      return {
        type: 'reservation-calendar',
        year: reservationCalendar.year,
        month: reservationCalendar.month,
      };
    }
    const visitCal = $('#visit-calendar-panel');
    if (visitCal && !visitCal.classList.contains('hidden') && visitCalendar.year) {
      return {
        type: 'visit-calendar',
        year: visitCalendar.year,
        month: visitCalendar.month,
      };
    }
    return null;
  }

  async function restoreLiveUiState(state) {
    if (!state) return;
    if (state.type === 'reservation-calendar' && typeof showReservationCalendar === 'function') {
      await showReservationCalendar(state.year, state.month);
    } else if (state.type === 'visit-calendar' && typeof showVisitCalendar === 'function') {
      await showVisitCalendar(state.year, state.month);
    }
  }

  function onVisibilityRefresh() {
    if (document.visibilityState === 'visible') checkSyncAndRefresh(true);
  }

  function startLiveSync() {
    stopLiveSync();
    autoRefreshTimer = setInterval(() => checkSyncAndRefresh(false), SYNC_POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityRefresh);
    connectSyncEvents();
    checkSyncAndRefresh(true);
  }

  function stopLiveSync() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityRefresh);
    if (syncEventSource) {
      syncEventSource.close();
      syncEventSource = null;
    }
    lastDataRevision = null;
  }

  function stopSessionLiveSync() {
    stopLiveSync();
    activeTab = null;
    activePanelLoader = null;
  }

  function connectSyncEvents() {
    if (!sessionToken || typeof EventSource === 'undefined') return;
    if (syncEventSource) {
      syncEventSource.close();
      syncEventSource = null;
    }
    const url = `/api/events?token=${encodeURIComponent(sessionToken)}`;
    syncEventSource = new EventSource(url);
    syncEventSource.addEventListener('connected', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data.revision === 'number') lastDataRevision = data.revision;
      } catch { /* ignore */ }
    });
    syncEventSource.addEventListener('change', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data.revision === 'number') lastDataRevision = data.revision;
      } catch { /* ignore */ }
      refreshNotifications();
      refreshCurrentPanel(true);
    });
    syncEventSource.onerror = () => {
      /* El navegador reintenta solo; el polling actúa de respaldo */
    };
  }

  async function checkSyncAndRefresh(force = false) {
    if (!sessionToken || !activePanelLoader) return;
    try {
      const sync = await api('GET', '/api/sync');
      const revision = sync && sync.revision;
      if (!force && lastDataRevision != null && revision === lastDataRevision) return;
      lastDataRevision = revision;
      await refreshNotifications();
      await refreshCurrentPanel(true);
    } catch {
      /* ignorar errores transitorios */
    }
  }

  async function refreshCurrentPanel(silent = true) {
    if (!activePanelLoader || activeTab == null) return;
    if (shouldPauseAutoRefresh()) return;
    if (refreshInFlight) return;
    refreshInFlight = true;
    const preserved = captureLiveUiState();
    try {
      if (currentUser) {
        currentUser = await api('GET', '/api/auth/me');
        renderUserInfo(currentUser);
      }
      await refreshNotifications();
      await activePanelLoader(activeTab, { silent });
      await restoreLiveUiState(preserved);
    } catch {
      /* ignorar errores transitorios en actualización en segundo plano */
    } finally {
      refreshInFlight = false;
    }
  }

  let notificationsCache = [];

  function updateNotifBadge(count) {
    const badge = $('#notif-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      show(badge);
    } else {
      badge.textContent = '0';
      hide(badge);
    }
  }

  function renderNotificationsList(items) {
    const list = $('#notif-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<p class="notif-empty">No hay notificaciones</p>';
      return;
    }
    list.innerHTML = items.map((n) => `<button type="button" class="notif-item ${n.read ? '' : 'is-unread'}" data-notif-id="${n.id}" data-link-tab="${n.linkTab || ''}">
      <p class="notif-item-title">${escapeHtml(n.title)}</p>
      <p class="notif-item-body">${escapeHtml(n.body || '')}</p>
      <span class="notif-item-time">${formatDate(n.createdAt)}</span>
    </button>`).join('');

    $$('[data-notif-id]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.notifId;
        const linkTab = btn.dataset.linkTab;
        try {
          if (!notificationsCache.find((n) => n.id === id)?.read) {
            await api('PATCH', `/api/notifications/${id}/read`);
          }
        } catch { /* ignore */ }
        hide($('#notif-panel'));
        await refreshNotifications();
        if (linkTab) navigateToNotificationTab(linkTab);
      };
    });
  }

  function navigateToNotificationTab(tab) {
    if (!currentUser || !tab) return;
    let navId = null;
    let loader = null;
    if (currentUser.role === 'admin') {
      navId = 'admin-nav';
      loader = loadAdminPanel;
    } else if (currentUser.role === 'resident') {
      navId = 'resident-nav';
      loader = loadResidentPanel;
    } else if (currentUser.role === 'staff') {
      navId = 'staff-nav';
      loader = loadStaffPanel;
    }
    if (!navId || !loader) return;
    const btn = $(`#${navId} .tab[data-tab="${tab}"]`);
    if (btn) {
      $$(`#${navId} .tab`).forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
    }
    updateMobileSectionTitle(navId);
    closeMobileNav();
    loader(tab);
  }

  async function refreshNotifications() {
    if (!sessionToken) return;
    try {
      const data = await api('GET', '/api/notifications');
      notificationsCache = data.items || [];
      updateNotifBadge(data.unreadCount || 0);
      renderNotificationsList(notificationsCache);
    } catch {
      /* ignore */
    }
  }

  function bindNotificationUi() {
    const bell = $('#notif-bell');
    const panel = $('#notif-panel');
    if (bell && !bell.dataset.bound) {
      bell.dataset.bound = '1';
      bell.onclick = async (e) => {
        e.stopPropagation();
        if (!panel) return;
        if (panel.classList.contains('hidden')) {
          await refreshNotifications();
          show(panel);
        } else {
          hide(panel);
        }
      };
    }

    const markAll = $('#notif-mark-all');
    if (markAll && !markAll.dataset.bound) {
      markAll.dataset.bound = '1';
      markAll.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api('PATCH', '/api/notifications/read-all');
          await refreshNotifications();
        } catch (err) {
          alert(err.message || 'No se pudieron marcar las notificaciones');
        }
      };
    }

    if (!document.body.dataset.notifOutsideBound) {
      document.body.dataset.notifOutsideBound = '1';
      document.addEventListener('click', (e) => {
        const wrap = $('.notif-wrap');
        const panelEl = $('#notif-panel');
        if (!wrap || !panelEl || panelEl.classList.contains('hidden')) return;
        if (!wrap.contains(e.target)) hide(panelEl);
      });
    }
  }

  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  function correspondenceStatusBadge(status) {
    const s = status || 'recibido';
    if (s === 'entregado') return '<span class="badge badge-aprobada">Entregado</span>';
    return '<span class="badge badge-pendiente">Recibido</span>';
  }

  function badge(status) {
    return `<span class="badge badge-${status}">${status}</span>`;
  }

  function renderCorrespondenceCard(c, options = {}) {
    const { showDeliverButton = false, residentView = false } = options;
    const status = c.status || 'recibido';
    let deliveryInfo = '';
    if (status === 'entregado') {
      deliveryInfo = `<div class="corr-delivery-info">
        <small>Entregado a: <strong>${escapeHtml(c.recipientName)}</strong></small><br>
        <small>${formatDate(c.deliveredAt)} — Vigilante: ${escapeHtml(c.deliveredByStaffName || '-')}</small>
      </div>`;
    }
    return `<div class="card corr-card">
      <div class="corr-card-header">
        <strong>${residentView ? 'Correspondencia' : escapeHtml(c.residentName)}</strong>
        ${correspondenceStatusBadge(status)}
      </div>
      <p>${escapeHtml(c.description || '')}</p>
      <small>Recibido: ${formatDate(c.receivedAt)} — Vigilante: ${escapeHtml(c.receivedByStaffName || '-')}</small>
      ${deliveryInfo}
      <div class="btn-group">
        ${c.hasPhoto ? `<button class="btn btn-sm" data-corr-photo="${c.id}">Ver imagen</button>` : ''}
        ${c.hasSignature ? `<button class="btn btn-sm" data-corr-signature="${c.id}">Ver firma</button>` : ''}
        ${showDeliverButton && status !== 'entregado' ? `<button class="btn btn-success btn-sm" data-deliver-corr="${c.id}">Realizar entrega</button>` : ''}
      </div>
    </div>`;
  }

  const signaturePad = {
    canvas: null,
    ctx: null,
    drawing: false,
    hasInk: false,
    lastX: 0,
    lastY: 0,
  };

  function prepareSignatureCanvas() {
    const canvas = $('#deliver-signature');
    if (!canvas) return;
    signaturePad.canvas = canvas;
    signaturePad.ctx = canvas.getContext('2d');
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const width = canvas.clientWidth || 560;
    const height = canvas.clientHeight || 180;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    signaturePad.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    signaturePad.ctx.lineCap = 'round';
    signaturePad.ctx.lineJoin = 'round';
    signaturePad.ctx.strokeStyle = '#0f172a';
    signaturePad.ctx.lineWidth = 2.25;
    clearSignaturePad();
  }

  function clearSignaturePad() {
    if (!signaturePad.canvas || !signaturePad.ctx) return;
    const canvas = signaturePad.canvas;
    const cssW = canvas.clientWidth || 560;
    const cssH = canvas.clientHeight || 180;
    signaturePad.ctx.save();
    signaturePad.ctx.setTransform(1, 0, 0, 1, 0, 0);
    signaturePad.ctx.clearRect(0, 0, canvas.width, canvas.height);
    signaturePad.ctx.restore();
    signaturePad.ctx.fillStyle = '#ffffff';
    signaturePad.ctx.fillRect(0, 0, cssW, cssH);
    signaturePad.hasInk = false;
    signaturePad.drawing = false;
    canvas.classList.remove('signing');
  }

  function signaturePoint(e) {
    const canvas = signaturePad.canvas;
    const rect = canvas.getBoundingClientRect();
    const src = e.touches && e.touches[0] ? e.touches[0] : e;
    return {
      x: src.clientX - rect.left,
      y: src.clientY - rect.top,
    };
  }

  function startSignature(e) {
    if (!signaturePad.ctx) return;
    e.preventDefault();
    const p = signaturePoint(e);
    signaturePad.drawing = true;
    signaturePad.lastX = p.x;
    signaturePad.lastY = p.y;
    signaturePad.canvas.classList.add('signing');
  }

  function moveSignature(e) {
    if (!signaturePad.drawing || !signaturePad.ctx) return;
    e.preventDefault();
    const p = signaturePoint(e);
    const ctx = signaturePad.ctx;
    ctx.beginPath();
    ctx.moveTo(signaturePad.lastX, signaturePad.lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    signaturePad.lastX = p.x;
    signaturePad.lastY = p.y;
    signaturePad.hasInk = true;
  }

  function endSignature(e) {
    if (!signaturePad.drawing) return;
    if (e) e.preventDefault();
    signaturePad.drawing = false;
  }

  function getSignatureDataUrl() {
    if (!signaturePad.canvas || !signaturePad.hasInk) return null;
    return signaturePad.canvas.toDataURL('image/png');
  }

  function corrMediaUrl(id, kind) {
    const base = `/api/correspondence/${id}/${kind}`;
    return sessionToken ? `${base}?token=${encodeURIComponent(sessionToken)}` : base;
  }

  function openMediaPreview(url, title = 'Vista previa') {
    const modal = $('#media-preview-modal');
    const img = $('#media-preview-image');
    const loading = $('#media-preview-loading');
    const errEl = $('#media-preview-error');
    const titleEl = $('#media-preview-title');
    if (!modal || !img) {
      window.open(url, '_blank');
      return;
    }

    if (titleEl) titleEl.textContent = title;
    hide(img);
    hide(errEl);
    if (errEl) errEl.textContent = '';
    show(loading);
    img.removeAttribute('src');
    show(modal);

    const preview = new Image();
    preview.onload = () => {
      img.src = preview.src;
      hide(loading);
      show(img);
    };
    preview.onerror = () => {
      hide(loading);
      if (errEl) {
        errEl.textContent = 'No se pudo cargar la imagen';
        show(errEl);
      }
    };
    preview.src = url;
  }

  function closeMediaPreview() {
    const modal = $('#media-preview-modal');
    const img = $('#media-preview-image');
    hide(modal);
    if (img) {
      hide(img);
      img.removeAttribute('src');
    }
    hide($('#media-preview-loading'));
    hide($('#media-preview-error'));
  }

  function bindMediaPreviewModal() {
    const modal = $('#media-preview-modal');
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = '1';
    $$('[data-close-media-preview]').forEach((el) => {
      el.addEventListener('click', closeMediaPreview);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeMediaPreview();
      }
    });
  }

  async function openDeliverModal(corrId) {
    const modal = $('#deliver-modal');
    if (!modal) return;

    let onDuty;
    try {
      onDuty = await api('GET', '/api/guard-shifts/on-duty');
    } catch (err) {
      alert(err.message || 'No hay vigilante en turno en este momento');
      return;
    }

    // Prefiere el vigilante logueado; debe ser el que está de turno (hora Colombia).
    const normalizeName = (n) =>
      (n || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
    if (
      currentUser?.role === 'staff' &&
      onDuty.staffName &&
      normalizeName(currentUser.name) !== normalizeName(onDuty.staffName)
    ) {
      alert(
        `Según la malla, el vigilante en turno ahora es ${onDuty.staffName}. ` +
          'Solo esa persona puede registrar la entrega en este horario.'
      );
      return;
    }

    $('#deliver-corr-id').value = corrId;
    $('#deliver-recipient').value = '';
    $('#deliver-datetime').value = new Date().toLocaleString('es-CO');
    $('#deliver-staff-name').value =
      (currentUser?.role === 'staff' && currentUser.name) || onDuty.staffName;
    show(modal);
    requestAnimationFrame(() => {
      prepareSignatureCanvas();
      $('#deliver-recipient').focus();
    });
  }

  function closeDeliverModal() {
    const modal = $('#deliver-modal');
    if (modal) hide(modal);
    const form = $('#form-deliver');
    if (form) form.reset();
    clearSignaturePad();
  }

  function formatDate(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('es-CO');
  }

  function localToday() {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }

  function shiftTypeDisplay(type) {
    if (type === 'day') return 'Día';
    if (type === 'night') return 'Noche';
    return 'Descanso';
  }

  function shiftScheduleDisplay(s) {
    if (s.type === 'rest') return '—';
    return `${s.startTime} - ${s.endTime}${s.endDate ? ' (' + s.endDate + ')' : ''}`;
  }

  function formatPeriodTitle(startDate, endDate) {
    const fmt = (d) => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(y, m - 1, day).toLocaleDateString('es-CO', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    };
    if (startDate === endDate) return fmt(startDate);
    return `${fmt(startDate)} — ${fmt(endDate)}`;
  }

  function renderShiftRows(shifts) {
    const sorted = [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
    return `<table><thead><tr><th>Fecha</th><th>Tipo</th><th>Vigilante</th><th>Horario</th><th>Horas</th></tr></thead>
      <tbody>${sorted.map((s) => `<tr class="${s.type === 'rest' ? 'shift-rest' : ''}">
        <td>${s.date}</td><td>${s.shiftLabel || shiftTypeDisplay(s.type)}</td>
        <td>${s.guardName}</td>
        <td>${shiftScheduleDisplay(s)}</td>
        <td>${s.type === 'rest' ? '—' : s.hours}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      const k = item[key] || 'Sin unidad';
      if (!acc[k]) acc[k] = [];
      acc[k].push(item);
      return acc;
    }, {});
  }

  function renderUnitGroups(items, renderItem, sortKey) {
    const groups = groupBy(items, 'unit');
    const units = Object.keys(groups).sort();
    if (!units.length) return '<p class="empty-state">No hay registros</p>';
    return units.map((unit) => {
      const list = sortKey
        ? groups[unit].sort((a, b) => new Date(b[sortKey]) - new Date(a[sortKey]))
        : groups[unit];
      return `<details class="unit-group">
        <summary>Unidad ${unit} (${list.length})</summary>
        <div class="group-content">${list.map(renderItem).join('')}</div>
      </details>`;
    }).join('');
  }

  function visitTimeline(visit) {
    if (!visit.timeline || !visit.timeline.length) return '';
    return `<div class="timeline">${visit.timeline.map((t) =>
      `<div class="timeline-item"><strong>${t.status}</strong> — ${formatDate(t.at)}</div>`
    ).join('')}</div>`;
  }

  // Login
  function bindPasswordToggle(btnSel, inputSel) {
    const btn = $(btnSel);
    const input = $(inputSel);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  bindPasswordToggle('#toggle-password', '#login-password');
  bindPasswordToggle('#toggle-pw-current', '#pw-current');
  bindPasswordToggle('#toggle-pw-new', '#pw-new');

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    const okEl = $('#login-success');
    hide(errEl);
    hide(okEl);
    try {
      const data = await api('POST', '/api/auth/login', {
        username: $('#login-username').value,
        password: $('#login-password').value,
      });
      sessionToken = data.token;
      localStorage.setItem('sessionToken', sessionToken);
      currentUser = data.user;
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      show(errEl);
    }
  });

  async function clearClientSession() {
    stopSessionLiveSync();
    notificationsCache = [];
    updateNotifBadge(0);
    const panel = $('#notif-panel');
    if (panel) hide(panel);
    sessionToken = '';
    localStorage.removeItem('sessionToken');
    currentUser = null;
  }

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    await clearClientSession();
    closeMobileNav();
    hide($('#password-gate-view'));
    hide($('#main-view'));
    show($('#login-view'));
  });

  async function checkSession() {
    if (!sessionToken) return false;
    try {
      currentUser = await api('GET', '/api/auth/me');
      return true;
    } catch {
      sessionToken = '';
      localStorage.removeItem('sessionToken');
      return false;
    }
  }

  function isSuperAdmin() {
    return currentUser && currentUser.role === 'admin' && currentUser.adminLevel === 'super';
  }

  function formatUserInfo(user) {
    if (!user) return '';

    if (user.role === 'admin') {
      if (user.adminLevel === 'super') return 'Hola Súper Admin';
      return 'Administración';
    }

    const displayName = String(user.name || user.username || 'usuario').trim();

    // Residente y vigilante: "Hola {nombre}"
    let text = `Hola ${displayName}`;
    if (user.role === 'resident' && user.unit) {
      text += ` · Unidad ${user.unit}`;
    }
    if (user.role === 'staff') {
      if (user.currentShift) {
        const s = user.currentShift;
        if (s.type === 'rest') {
          text += ` · ${s.shiftLabel}`;
        } else {
          text += ` · ${s.shiftLabel}: ${s.schedule}`;
        }
      } else {
        text += ' · Sin turno en malla para hoy';
      }
    }
    return text;
  }

  function renderUserInfo(user) {
    const el = $('#user-info');
    if (!el) return;
    const isSuper = user && user.role === 'admin' && user.adminLevel === 'super';
    el.classList.toggle('is-super-admin', Boolean(isSuper));
    if (isSuper) {
      el.innerHTML = 'Hola <span class="user-info-super">Súper Admin</span>';
      return;
    }
    el.textContent = formatUserInfo(user);
  }

  function openAdminResidentPasswordModal(resident) {
    const modal = $('#admin-resident-password-modal');
    if (!modal) return;
    $('#admin-resident-password-id').value = resident.id;
    $('#admin-resident-password-value').value = '';
    $('#admin-resident-password-sub').textContent =
      `Asigna una contraseña temporal a ${resident.name} (Unidad ${resident.unit}).`;
    hide($('#admin-resident-password-error'));
    show(modal);
    requestAnimationFrame(() => $('#admin-resident-password-value')?.focus());
  }

  function closeAdminResidentPasswordModal() {
    const modal = $('#admin-resident-password-modal');
    if (modal) hide(modal);
    const form = $('#form-admin-resident-password');
    if (form) form.reset();
  }

  function bindAdminResidentPasswordModal() {
    $$('[data-close-resident-password-modal]').forEach((el) => {
      el.onclick = closeAdminResidentPasswordModal;
    });

    const form = $('#form-admin-resident-password');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.onsubmit = async (e) => {
        e.preventDefault();
        const errEl = $('#admin-resident-password-error');
        hide(errEl);
        const id = $('#admin-resident-password-id').value;
        const password = $('#admin-resident-password-value').value.trim();
        if (!password) {
          errEl.textContent = 'La contraseña es requerida';
          show(errEl);
          return;
        }
        try {
          await api('PATCH', `/api/residents/${id}/password`, { password });
          closeAdminResidentPasswordModal();
          alert('Contraseña temporal actualizada. El residente deberá cambiarla al ingresar.');
          loadAdminPanel('residents');
        } catch (err) {
          errEl.textContent = err.message || 'No se pudo cambiar la contraseña';
          show(errEl);
        }
      };
    }
  }

  function updatePasswordRules(password) {
    const rules = {
      length: password.length >= 6,
      upper: /[A-Z]/.test(password),
      number: /[0-9]/.test(password),
    };
    Object.entries(rules).forEach(([key, ok]) => {
      const li = $(`#pw-rules [data-rule="${key}"]`);
      if (!li) return;
      li.classList.toggle('ok', ok);
      li.classList.toggle('bad', password.length > 0 && !ok);
    });
    return rules.length && rules.upper && rules.number;
  }

  function openForcePasswordGate() {
    hide($('#login-view'));
    hide($('#main-view'));
    const form = $('#form-change-password');
    if (form) form.reset();
    updatePasswordRules('');
    hide($('#password-change-error'));
    show($('#password-gate-view'));
    requestAnimationFrame(() => $('#pw-current')?.focus());
  }

  async function returnToLoginAfterPasswordChange() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    await clearClientSession();
    hide($('#password-gate-view'));
    hide($('#main-view'));
    show($('#login-view'));
    const okEl = $('#login-success');
    if (okEl) {
      okEl.textContent = 'Contraseña actualizada correctamente. Ingresa con tu nueva contraseña.';
      show(okEl);
    }
    $('#login-password').value = '';
    requestAnimationFrame(() => $('#login-password')?.focus());
  }

  function bindPasswordChangeModal() {
    const pwNew = $('#pw-new');
    if (pwNew && !pwNew.dataset.bound) {
      pwNew.dataset.bound = '1';
      pwNew.addEventListener('input', () => updatePasswordRules(pwNew.value));
    }

    const form = $('#form-change-password');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.onsubmit = async (e) => {
        e.preventDefault();
        const errEl = $('#password-change-error');
        hide(errEl);
        const currentPassword = $('#pw-current').value;
        const newPassword = $('#pw-new').value;
        if (!updatePasswordRules(newPassword)) {
          errEl.textContent = 'La contraseña nueva debe tener mínimo 6 caracteres, 1 mayúscula y 1 número';
          show(errEl);
          return;
        }
        try {
          await api('POST', '/api/auth/change-password', {
            currentPassword,
            newPassword,
          });
          await returnToLoginAfterPasswordChange();
        } catch (err) {
          errEl.textContent = err.message || 'No se pudo cambiar la contraseña';
          show(errEl);
        }
      };
    }
  }

  function showApp() {
    hide($('#login-view'));
    hide($('#password-gate-view'));
    hide($('#login-success'));

    if (currentUser.role === 'resident' && currentUser.mustChangePassword) {
      openForcePasswordGate();
      return;
    }

    show($('#main-view'));
    renderUserInfo(currentUser);
    bindMobileNav();
    closeMobileNav();

    hide($('#admin-nav'));
    hide($('#resident-nav'));
    hide($('#staff-nav'));

    if (currentUser.role === 'admin') {
      show($('#admin-nav'));
      initAdminTabs();
      loadAdminPanel('residents');
      startLiveSync();
      bindNotificationUi();
      refreshNotifications();
    } else if (currentUser.role === 'resident') {
      show($('#resident-nav'));
      initResidentTabs();
      loadResidentPanel('res-visits');
      startLiveSync();
      bindNotificationUi();
      refreshNotifications();
    } else if (currentUser.role === 'staff') {
      show($('#staff-nav'));
      initStaffTabs();
      loadStaffPanel('sec-announcements');
      startLiveSync();
      bindNotificationUi();
      refreshNotifications();
    }

    openPrivacyNotice({ requireAccept: true });
  }

  let privacyRequireAccept = false;

  function openPrivacyNotice(options = {}) {
    const { requireAccept = false } = options;
    privacyRequireAccept = requireAccept;
    const modal = $('#privacy-modal');
    const acceptBtn = $('#privacy-accept-btn');
    const closeBtn = $('#privacy-close-btn');
    if (!modal) return;
    if (requireAccept) {
      if (acceptBtn) show(acceptBtn);
      if (closeBtn) hide(closeBtn);
    } else {
      if (acceptBtn) hide(acceptBtn);
      if (closeBtn) show(closeBtn);
    }
    show(modal);
  }

  function closePrivacyNotice() {
    hide($('#privacy-modal'));
    privacyRequireAccept = false;
  }

  function bindPrivacyNotice() {
    const modal = $('#privacy-modal');
    if (!modal || modal.dataset.bound) return;
    modal.dataset.bound = '1';

    const acceptBtn = $('#privacy-accept-btn');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => closePrivacyNotice());
    }
    const closeBtn = $('#privacy-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (!privacyRequireAccept) closePrivacyNotice();
      });
    }
    const backdrop = $('[data-privacy-backdrop]');
    if (backdrop) {
      backdrop.addEventListener('click', () => {
        if (!privacyRequireAccept) closePrivacyNotice();
      });
    }
    $$('[data-open-privacy]').forEach((btn) => {
      btn.addEventListener('click', () => openPrivacyNotice({ requireAccept: false }));
    });
    $$('[data-year]').forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });
  }

  function closeMobileNav() {
    document.body.classList.remove('nav-open');
    const toggle = $('#nav-toggle');
    const backdrop = $('#nav-backdrop');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (backdrop) hide(backdrop);
  }

  function openMobileNav() {
    document.body.classList.add('nav-open');
    const toggle = $('#nav-toggle');
    const backdrop = $('#nav-backdrop');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    if (backdrop) show(backdrop);
  }

  function toggleMobileNav() {
    if (document.body.classList.contains('nav-open')) closeMobileNav();
    else openMobileNav();
  }

  function updateMobileSectionTitle(navId) {
    const el = $('#mobile-section');
    if (!el) return;
    const active = $(`#${navId} .tab.active`);
    el.textContent = active ? active.textContent.trim() : '';
  }

  function bindMobileNav() {
    const toggle = $('#nav-toggle');
    const backdrop = $('#nav-backdrop');
    if (toggle && !toggle.dataset.bound) {
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', toggleMobileNav);
    }
    if (backdrop && !backdrop.dataset.bound) {
      backdrop.dataset.bound = '1';
      backdrop.addEventListener('click', closeMobileNav);
    }
    if (!document.body.dataset.navEscBound) {
      document.body.dataset.navEscBound = '1';
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMobileNav();
      });
    }
  }

  function initTabs(navId, loadFn) {
    $$(`#${navId} .tab`).forEach((tab) => {
      tab.onclick = () => {
        $$(`#${navId} .tab`).forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        updateMobileSectionTitle(navId);
        closeMobileNav();
        loadFn(tab.dataset.tab);
      };
    });
    updateMobileSectionTitle(navId);
  }

  function initAdminTabs() { initTabs('admin-nav', loadAdminPanel); }
  function initResidentTabs() { initTabs('resident-nav', loadResidentPanel); }
  function initStaffTabs() { initTabs('staff-nav', loadStaffPanel); }

  // Admin panels
  async function loadAdminPanel(tab, options = {}) {
    const { silent = false } = options;
    activeTab = tab;
    activePanelLoader = loadAdminPanel;
    const content = $('#content');
    if (!silent) content.innerHTML = '<p>Cargando...</p>';
    try {
      switch (tab) {
        case 'residents': content.innerHTML = await renderResidentsAdmin(); break;
        case 'visits': content.innerHTML = await renderVisitsAdmin(); break;
        case 'reservations': content.innerHTML = await renderReservationsAdmin(); break;
        case 'maintenance': content.innerHTML = await renderMaintenanceAdmin(); break;
        case 'payments': content.innerHTML = await renderPaymentsAdmin(); break;
        case 'announcements': content.innerHTML = await renderAnnouncementsAdmin(); break;
        case 'staff': content.innerHTML = await renderStaffAdmin(); break;
        case 'audit': content.innerHTML = await renderAuditAdmin(); break;
        case 'guard-shifts': content.innerHTML = await renderGuardShiftsAdmin(); break;
        case 'correspondence-admin': content.innerHTML = await renderCorrespondenceAdmin(); break;
      }
      bindAdminEvents(tab);
    } catch (err) {
      if (!silent) content.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  async function renderResidentsAdmin() {
    const residents = await api('GET', '/api/residents');
    return `<div class="card">
      <h2>Residentes</h2>
      <details class="collapsible-form">
        <summary>+ Crear residente</summary>
        <form id="form-resident" class="form-grid">
          <label>Nombre <input name="name" required></label>
          <label>Unidad <input name="unit" required></label>
          <label>Usuario <input name="username" required></label>
          <label>Teléfono <input name="phone"></label>
          <label>Email <input name="email" type="email"></label>
          <label>Contraseña temporal <input name="tempPassword" required></label>
          <div class="btn-group"><button type="submit" class="btn btn-primary">Crear</button></div>
        </form>
      </details>
      <table>
        <thead><tr><th>Nombre</th><th>Unidad</th><th>Usuario</th><th>Teléfono</th><th>Estado</th><th></th></tr></thead>
        <tbody>${residents.map((r) => `<tr>
          <td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.unit)}</td><td>${escapeHtml(r.username)}</td><td>${escapeHtml(r.phone || '-')}</td>
          <td>${r.active !== false ? badge('aprobada') : badge('inactive')}</td>
          <td class="btn-group">
            <button type="button" class="btn btn-secondary btn-sm" data-pass-resident="${r.id}" data-pass-resident-name="${escapeHtml(r.name)}" data-pass-resident-unit="${escapeHtml(r.unit)}">Contraseña</button>
            <button type="button" class="btn btn-danger btn-sm" data-delete-resident="${r.id}">Eliminar</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  async function renderVisitsAdmin() {
    const visits = await api('GET', '/api/visits');
    const canDelete = isSuperAdmin();
    const grouped = renderUnitGroups(visits, (v) => `<div class="card">
      <strong>${escapeHtml(v.visitorName)}</strong> — ${escapeHtml(v.document)}
      ${v.hasPet ? '<span class="pet-badge">Con mascota</span>' : ''}<br>
      <small>${escapeHtml(v.purpose || '')}</small> ${badge(v.status)}
      ${v.visitorPhone ? `<br><small>Tel: ${escapeHtml(v.visitorPhone)}</small>` : ''}
      ${v.vehicleModel || v.vehiclePlates
        ? `<br><small>${escapeHtml([v.vehicleModel, v.vehiclePlates].filter(Boolean).join(' · '))}</small>`
        : ''}
      ${renderPetDetails(v)}
      ${visitTimeline(v)}
      ${canDelete ? `<div class="btn-group">
        <button class="btn btn-danger btn-sm" data-delete-visit="${v.id}">Eliminar</button>
      </div>` : ''}
    </div>`, 'createdAt');
    return `<div class="card"><h2>Visitas por unidad</h2>
      <details class="collapsible-form"><summary>+ Registrar visita</summary>
        <form id="form-visit" class="form-grid">
          <label>Unidad <input name="unit" required></label>
          <label>Visitante <input name="visitorName" required></label>
          <label>Documento <input name="document" required></label>
          <label>Propósito <input name="purpose" required></label>
          <div class="btn-group"><button type="submit" class="btn btn-primary">Registrar</button></div>
        </form>
      </details>${grouped}</div>`;
  }

  async function renderReservationsAdmin() {
    const reservations = await api('GET', '/api/reservations');
    const sorted = [...reservations].sort((a, b) => {
      const da = `${a.date || ''} ${a.startTime || ''}`;
      const db = `${b.date || ''} ${b.startTime || ''}`;
      return db.localeCompare(da);
    });
    return `<div class="card"><h2>Reservas por unidad</h2>
      ${sorted.length
        ? renderUnitGroups(sorted, (r) => renderReservationCard(r, { showActions: true }), 'date')
        : '<p class="empty-state">No hay reservas registradas</p>'}
    </div>`;
  }

  function renderReservationCard(r, options = {}) {
    const { showActions = false } = options;
    const who = r.residentName || `Unidad ${r.unit}`;
    return `<div class="card corr-card resv-admin-card">
      <div class="corr-card-header">
        <strong>${escapeHtml(r.area || '')}</strong>
        ${badge(r.status)}
      </div>
      <p>Reservado por: <strong>${escapeHtml(who)}</strong></p>
      <small>${formatReservationDate(r.date)} — ${escapeHtml(r.startTime || '')} a ${escapeHtml(r.endTime || '')}</small>
      ${r.notes ? `<p class="resv-notes">${escapeHtml(r.notes)}</p>` : ''}
      ${r.requiresDeposit ? '<small class="resv-deposit-note">Requiere depósito</small>' : ''}
      ${showActions ? `<div class="btn-group">
        ${r.status === 'pendiente' ? `
          <button type="button" class="btn btn-success btn-sm" data-approve-res="${r.id}">Aprobar</button>
          <button type="button" class="btn btn-danger btn-sm" data-reject-res="${r.id}">Rechazar</button>` : ''}
        <button type="button" class="btn btn-danger btn-sm" data-delete-res="${r.id}">Eliminar</button>
      </div>` : ''}
    </div>`;
  }

  async function renderMaintenanceAdmin() {
    const items = await api('GET', '/api/maintenance');
    return `<div class="card"><h2>Mantenimiento</h2>
      <details class="collapsible-form"><summary>+ Nuevo reporte</summary>
        <form id="form-maintenance" class="form-grid">
          <label>Unidad <input name="unit" required></label>
          <label>Título <input name="title" required></label>
          <label>Descripción <textarea name="description" required></textarea></label>
          <label>Prioridad <select name="priority"><option>media</option><option>alta</option><option>baja</option></select></label>
          <div class="btn-group"><button type="submit" class="btn btn-primary">Crear</button></div>
        </form>
      </details>
      <table><thead><tr><th>Unidad</th><th>Título</th><th>Prioridad</th><th>Estado</th><th></th></tr></thead>
      <tbody>${items.map((m) => `<tr>
        <td>${escapeHtml(m.unit)}</td><td>${escapeHtml(m.title)}</td><td>${escapeHtml(m.priority)}</td><td>${badge(m.status)}</td>
        <td><select data-maint-status="${escapeHtml(m.id)}">
          <option value="abierto" ${m.status==='abierto'?'selected':''}>abierto</option>
          <option value="en_proceso" ${m.status==='en_proceso'?'selected':''}>en_proceso</option>
          <option value="cerrado" ${m.status==='cerrado'?'selected':''}>cerrado</option>
        </select></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  async function renderPaymentsAdmin() {
    const payments = await api('GET', '/api/payments');
    return `<div class="card"><h2>Pagos</h2>
      <details class="collapsible-form"><summary>+ Registrar pago</summary>
        <form id="form-payment" class="form-grid">
          <label>Unidad <input name="unit" required></label>
          <label>Concepto <input name="concept" required></label>
          <label>Monto <input name="amount" type="number" required></label>
          <label>Vencimiento <input name="dueDate" type="date" required></label>
          <div class="btn-group"><button type="submit" class="btn btn-primary">Crear</button></div>
        </form>
      </details>
      <table><thead><tr><th>Unidad</th><th>Concepto</th><th>Monto</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
      <tbody>${payments.map((p) => `<tr>
        <td>${escapeHtml(p.unit)}</td><td>${escapeHtml(p.concept)}</td><td>$${Number(p.amount).toLocaleString()}</td>
        <td>${escapeHtml(p.dueDate)}</td><td>${badge(p.status)}</td>
        <td>${p.status === 'pendiente' ? `<button class="btn btn-success btn-sm" data-pay="${escapeHtml(p.id)}">Marcar pagado</button>` : ''}
        <button class="btn btn-danger btn-sm" data-delete-pay="${escapeHtml(p.id)}">Eliminar</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sortAnnouncements(announcements) {
    return [...announcements].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function renderAnnouncementCard(a, options = {}) {
    const { showDelete = false } = options;
    const dateLabel = a.createdAt
      ? new Date(a.createdAt).toLocaleDateString('es-CO', {
          weekday: 'short',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : '-';
    return `<article class="ann-card">
      <div class="ann-card-accent" aria-hidden="true"></div>
      <div class="ann-card-body">
        <div class="ann-card-meta">
          <span class="ann-pill">Comunicado</span>
          <time datetime="${escapeHtml(a.createdAt || '')}">${escapeHtml(dateLabel)}</time>
        </div>
        <h3 class="ann-card-title">${escapeHtml(a.title)}</h3>
        <p class="ann-card-text">${escapeHtml(a.body)}</p>
        ${showDelete
          ? `<div class="ann-card-actions">
              <button type="button" class="btn btn-danger btn-sm" data-delete-ann="${a.id}">Eliminar</button>
            </div>`
          : ''}
      </div>
    </article>`;
  }

  function renderAnnouncementsBoard(announcements, options = {}) {
    const {
      title = 'Anuncios',
      subtitle = 'Comunicados oficiales del conjunto residencial.',
      showCreate = false,
      showDelete = false,
      emptyText = 'No hay anuncios publicados por ahora.',
    } = options;
    const sorted = sortAnnouncements(announcements);

    return `<div class="ann-module">
      <div class="resv-hero ann-hero">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p class="resv-hero-sub">${escapeHtml(subtitle)}</p>
        </div>
        <span class="ann-hero-count">${sorted.length} publicado${sorted.length === 1 ? '' : 's'}</span>
      </div>

      ${showCreate ? `<section class="ann-composer resv-section">
        <details class="collapsible-form ann-composer-details">
          <summary>+ Publicar nuevo anuncio</summary>
          <form id="form-announcement" class="ann-composer-form">
            <label>Título
              <input name="title" required maxlength="120" placeholder="Ej: Mantenimiento de zonas comunes">
            </label>
            <label>Contenido
              <textarea name="body" required rows="4" placeholder="Escribe el mensaje para residentes y vigilancia..."></textarea>
            </label>
            <div class="btn-group">
              <button type="submit" class="btn btn-primary">Publicar anuncio</button>
            </div>
          </form>
        </details>
      </section>` : ''}

      <section class="ann-feed">
        ${sorted.length
          ? sorted.map((a) => renderAnnouncementCard(a, { showDelete })).join('')
          : `<div class="ann-empty resv-section">
              <strong>Sin anuncios</strong>
              <p>${escapeHtml(emptyText)}</p>
            </div>`}
      </section>
    </div>`;
  }

  async function renderAnnouncementsAdmin() {
    const announcements = await api('GET', '/api/announcements');
    return renderAnnouncementsBoard(announcements, {
      title: 'Anuncios',
      subtitle: 'Publica comunicados para residentes y personal de seguridad.',
      showCreate: true,
      showDelete: true,
      emptyText: 'Aún no hay comunicados. Publica el primero para informar a la comunidad.',
    });
  }

  async function renderStaffAdmin() {
    const staff = await api('GET', '/api/staff');
    return `<div class="card"><h2>Vigilantes</h2>
      <details class="collapsible-form"><summary>+ Agregar vigilante</summary>
        <form id="form-staff" class="form-grid">
          <label>Nombre <input name="name" required></label>
          <label>Usuario <input name="username" required></label>
          <label>Teléfono <input name="phone" required></label>
          <label>Cargo <input name="position"></label>
          <label>Contraseña <input name="password" type="password" required></label>
          <div class="btn-group"><button type="submit" class="btn btn-primary">Crear</button></div>
        </form>
      </details>
      <table><thead><tr><th>Nombre</th><th>Usuario</th><th>Teléfono</th><th>Cargo</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>${staff.map((s) => `<tr>
        <td>${s.name}</td><td>${s.username}</td><td>${s.phone}</td><td>${s.position || '-'}</td>
        <td>${s.active !== false ? badge('aprobada') : badge('inactive')}</td>
        <td class="btn-group">
          <button class="btn btn-sm" data-edit-staff="${s.id}" data-name="${s.name}" data-username="${s.username}" data-phone="${s.phone}" data-position="${s.position||''}">Editar</button>
          <button class="btn btn-warning btn-sm" data-toggle-staff="${s.id}" data-active="${s.active!==false}">${s.active!==false?'Deshabilitar':'Habilitar'}</button>
          <button class="btn btn-secondary btn-sm" data-pass-staff="${s.id}">Contraseña</button>
          ${isSuperAdmin() ? `<button class="btn btn-danger btn-sm" data-delete-staff="${s.id}">Eliminar</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  const AUDIT_CATEGORY_LABELS = {
    auth: 'Autenticación',
    residents: 'Residentes',
    visits: 'Visitas',
    reservations: 'Reservas',
    maintenance: 'Mantenimiento',
    announcements: 'Anuncios',
    payments: 'Pagos',
    staff: 'Vigilantes',
    correspondence: 'Correspondencia',
    guardShifts: 'Turnos',
  };

  function labelAuditCategory(category) {
    if (!category) return '-';
    return AUDIT_CATEGORY_LABELS[category] || category;
  }

  function auditActorLabel(entry) {
    const name = entry.actorName || entry.actorId || 'Desconocido';
    if (entry.actorRole === 'resident' && entry.actorUnit) {
      return `${name} (Unidad ${entry.actorUnit})`;
    }
    return name;
  }

  async function renderAuditAdmin() {
    const logs = await api('GET', '/api/audit');
    const byActor = {};
    logs.forEach((l) => {
      const key = auditActorLabel(l);
      if (!byActor[key]) byActor[key] = [];
      byActor[key].push(l);
    });

    const categories = [...new Set(logs.map((l) => l.category).filter(Boolean))]
      .sort((a, b) => labelAuditCategory(a).localeCompare(labelAuditCategory(b), 'es'));

    let html = `<div class="card"><h2>Auditoría</h2>
      <div class="toolbar">
        <input id="audit-q" placeholder="Buscar..." value="">
        <select id="audit-category"><option value="">Todas las categorías</option>
          ${categories.map((c) =>
            `<option value="${c}">${labelAuditCategory(c)}</option>`
          ).join('')}
        </select>
        <button class="btn btn-primary btn-sm" id="audit-filter">Filtrar</button>
      </div>`;

    for (const [actor, entries] of Object.entries(byActor)) {
      entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      html += `<details class="audit-group"><summary><strong>${escapeHtml(actor)}</strong></summary>
        <table><thead><tr><th>Fecha</th><th>Acción</th><th>Detalle</th><th></th></tr></thead>
        <tbody>${entries.map((e) => `<tr>
          <td>${formatDate(e.timestamp)}</td><td>${e.action}</td><td>${escapeHtml(e.details || '-')}</td>
          <td>${e.category === 'correspondence' && e.entityId !== 'all' ? `<button class="btn btn-sm" data-audit-photo="${e.entityId}">Ver imagen</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></details>`;
    }
    html += '</div>';
    return html;
  }

  async function renderGuardShiftsAdmin() {
    const data = await api('GET', '/api/guard-shifts');
    const periods = data.periods || [];
    const suggestedStart = data.suggestedStartDate || localToday();
    const startValue = periods.length ? suggestedStart : localToday();

    const periodsHtml = periods.length
      ? periods.map((p) => `<details class="shift-period">
          <summary title="Clic para mostrar u ocultar el detalle">
            <span class="summary-leading">
              <span class="period-toggle" aria-hidden="true"></span>
              <span class="summary-text">
                <strong>${formatPeriodTitle(p.startDate, p.endDate)}</strong>
                <span class="period-meta">${p.shifts.length} registros</span>
              </span>
            </span>
            <span class="summary-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-download-period="${p.id}">Descargar CSV</button>
              <button type="button" class="btn btn-danger btn-sm" data-delete-period="${p.id}">Eliminar</button>
            </span>
          </summary>
          ${renderShiftRows(p.shifts)}
        </details>`).join('')
      : '<p class="empty-state">No hay mallas de turnos generadas</p>';

    return `<div class="card"><h2>Turnos de vigilancia</h2>
      <div class="toolbar">
        <label>Inicio <input type="date" id="shift-start" value="${startValue}"></label>
        <label>Días <input type="number" id="shift-days" value="14" min="1" max="90" style="width:80px"></label>
        <button class="btn btn-primary" id="generate-shifts">Generar turnos</button>
      </div>
      <p class="hint">Cada generación crea una malla independiente agrupada por fechas. La rotación continúa desde la última malla generada.</p>
      <div class="shift-periods">${periodsHtml}</div>
    </div>`;
  }

  async function renderCorrespondenceAdmin() {
    const items = await api('GET', '/api/correspondence');
    return `<div class="card"><h2>Correspondencia recibida</h2>
      ${isSuperAdmin()
        ? `<button class="btn btn-danger" id="clear-correspondence" ${!items.length ? 'disabled' : ''}>Limpiar todo</button>`
        : ''}
      ${renderUnitGroups(items, (c) => renderCorrespondenceCard(c), 'receivedAt')}</div>`;
  }

  function bindAdminEvents(tab) {
    const formResident = $('#form-resident');
    if (formResident) formResident.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(formResident);
      await api('POST', '/api/residents', Object.fromEntries(fd));
      loadAdminPanel('residents');
    };

    $$('[data-delete-resident]').forEach((btn) => {
      btn.onclick = async () => {
        if (confirm('¿Eliminar residente?')) {
          await api('DELETE', `/api/residents/${btn.dataset.deleteResident}`);
          loadAdminPanel('residents');
        }
      };
    });

    $$('[data-pass-resident]').forEach((btn) => {
      btn.onclick = () => openAdminResidentPasswordModal({
        id: btn.dataset.passResident,
        name: btn.dataset.passResidentName,
        unit: btn.dataset.passResidentUnit,
      });
    });

    const formVisit = $('#form-visit');
    if (formVisit) formVisit.onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/visits', Object.fromEntries(new FormData(formVisit)));
      loadAdminPanel('visits');
    };

    $$('[data-delete-visit]').forEach((btn) => {
      btn.onclick = async () => {
        await api('DELETE', `/api/visits/${btn.dataset.deleteVisit}`);
        loadAdminPanel('visits');
      };
    });
    bindVisitMediaButtons();

    $$('[data-approve-res]').forEach((btn) => {
      btn.onclick = async () => {
        await api('PATCH', `/api/reservations/${btn.dataset.approveRes}`, { status: 'aprobada' });
        loadAdminPanel('reservations');
      };
    });
    $$('[data-reject-res]').forEach((btn) => {
      btn.onclick = async () => {
        await api('PATCH', `/api/reservations/${btn.dataset.rejectRes}`, { status: 'rechazada' });
        loadAdminPanel('reservations');
      };
    });
    $$('[data-delete-res]').forEach((btn) => {
      btn.onclick = async () => {
        await api('DELETE', `/api/reservations/${btn.dataset.deleteRes}`);
        loadAdminPanel('reservations');
      };
    });

    const formMaint = $('#form-maintenance');
    if (formMaint) formMaint.onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/maintenance', Object.fromEntries(new FormData(formMaint)));
      loadAdminPanel('maintenance');
    };
    $$('[data-maint-status]').forEach((sel) => {
      sel.onchange = async () => {
        await api('PATCH', `/api/maintenance/${sel.dataset.maintStatus}`, { status: sel.value });
      };
    });

    const formPay = $('#form-payment');
    if (formPay) formPay.onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/payments', Object.fromEntries(new FormData(formPay)));
      loadAdminPanel('payments');
    };
    $$('[data-pay]').forEach((btn) => {
      btn.onclick = async () => {
        await api('PATCH', `/api/payments/${btn.dataset.pay}`, { status: 'pagado' });
        loadAdminPanel('payments');
      };
    });
    $$('[data-delete-pay]').forEach((btn) => {
      btn.onclick = async () => {
        await api('DELETE', `/api/payments/${btn.dataset.deletePay}`);
        loadAdminPanel('payments');
      };
    });

    const formAnn = $('#form-announcement');
    if (formAnn) formAnn.onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/announcements', Object.fromEntries(new FormData(formAnn)));
      loadAdminPanel('announcements');
    };
    $$('[data-delete-ann]').forEach((btn) => {
      btn.onclick = async () => {
        await api('DELETE', `/api/announcements/${btn.dataset.deleteAnn}`);
        loadAdminPanel('announcements');
      };
    });

    const formStaff = $('#form-staff');
    if (formStaff) formStaff.onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', '/api/staff', Object.fromEntries(new FormData(formStaff)));
      loadAdminPanel('staff');
    };
    $$('[data-edit-staff]').forEach((btn) => {
      btn.onclick = async () => {
        const name = prompt('Nombre:', btn.dataset.name);
        const username = prompt('Usuario:', btn.dataset.username);
        const phone = prompt('Teléfono:', btn.dataset.phone);
        const position = prompt('Cargo:', btn.dataset.position);
        if (name && username && phone) {
          await api('PATCH', `/api/staff/${btn.dataset.editStaff}`, { name, username, phone, position });
          loadAdminPanel('staff');
        }
      };
    });
    $$('[data-toggle-staff]').forEach((btn) => {
      btn.onclick = async () => {
        await api('PATCH', `/api/staff/${btn.dataset.toggleStaff}/status`, { active: btn.dataset.active === 'false' });
        loadAdminPanel('staff');
      };
    });
    $$('[data-pass-staff]').forEach((btn) => {
      btn.onclick = async () => {
        const password = prompt('Nueva contraseña:');
        if (password) {
          await api('PATCH', `/api/staff/${btn.dataset.passStaff}/password`, { password });
          alert('Contraseña actualizada');
        }
      };
    });
    $$('[data-delete-staff]').forEach((btn) => {
      btn.onclick = async () => {
        if (confirm('¿Eliminar personal?')) {
          await api('DELETE', `/api/staff/${btn.dataset.deleteStaff}`);
          loadAdminPanel('staff');
        }
      };
    });

    const auditFilter = $('#audit-filter');
    if (auditFilter) auditFilter.onclick = async () => {
      const q = $('#audit-q').value;
      const category = $('#audit-category').value;
      let url = '/api/audit?';
      if (q) url += `q=${encodeURIComponent(q)}&`;
      if (category) url += `category=${encodeURIComponent(category)}`;
      const logs = await api('GET', url);
      const content = $('#content');
      content.innerHTML = `<div class="card"><h2>Resultados (${logs.length})</h2>
        <table><thead><tr><th>Fecha</th><th>Actor</th><th>Categoría</th><th>Acción</th><th>Detalle</th></tr></thead>
        <tbody>${logs.map((e) => `<tr>
          <td>${formatDate(e.timestamp)}</td><td>${escapeHtml(auditActorLabel(e))}</td><td>${labelAuditCategory(e.category)}</td>
          <td>${e.action}</td><td>${escapeHtml(e.details || '-')}</td>
        </tr>`).join('')}</tbody></table>
        <button class="btn btn-secondary" id="audit-back">Volver</button></div>`;
      $('#audit-back').onclick = () => loadAdminPanel('audit');
    };

    $$('[data-audit-photo], [data-corr-photo]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(
        corrMediaUrl(btn.dataset.auditPhoto || btn.dataset.corrPhoto, 'photo'),
        'Imagen del producto'
      );
    });
    $$('[data-corr-signature]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(
        corrMediaUrl(btn.dataset.corrSignature, 'signature'),
        'Firma de entrega'
      );
    });

    const genShifts = $('#generate-shifts');
    if (genShifts) genShifts.onclick = async () => {
      try {
        await api('POST', '/api/guard-shifts/generate', {
          startDate: $('#shift-start').value,
          days: Number($('#shift-days').value),
        });
        loadAdminPanel('guard-shifts');
      } catch (err) {
        alert(err.message || 'No se pudo generar la malla');
      }
    };

    $$('[data-download-period]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const periodId = btn.dataset.downloadPeriod;
        const res = await fetch(`/api/guard-shifts.csv?periodId=${encodeURIComponent(periodId)}`, {
          headers: { 'x-session-token': sessionToken },
        });
        if (!res.ok) {
          alert('No se pudo descargar el CSV');
          return;
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `turnos-${periodId}.csv`;
        a.click();
      };
    });

    $$('[data-delete-period]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm('¿Eliminar esta malla de turnos?')) return;
        try {
          await api('DELETE', `/api/guard-shifts/${btn.dataset.deletePeriod}`);
          loadAdminPanel('guard-shifts');
        } catch (err) {
          alert(err.message || 'No se pudo eliminar la malla');
        }
      };
    });

    const clearCorr = $('#clear-correspondence');
    if (clearCorr) clearCorr.onclick = async () => {
      if (confirm('¿Limpiar toda la correspondencia?')) {
        await api('DELETE', '/api/correspondence');
        loadAdminPanel('correspondence-admin');
      }
    };
  }

  // Resident panels
  async function loadResidentPanel(tab, options = {}) {
    const { silent = false } = options;
    activeTab = tab;
    activePanelLoader = loadResidentPanel;
    const content = $('#content');
    if (!silent) content.innerHTML = '<p>Cargando...</p>';
    try {
      if (tab === 'res-visits') content.innerHTML = await renderResidentVisits();
      else if (tab === 'res-reservations') content.innerHTML = await renderResidentReservations();
      else if (tab === 'res-correspondence') content.innerHTML = await renderResidentCorrespondence();
      else if (tab === 'res-announcements') content.innerHTML = await renderResidentAnnouncements();
      bindResidentEvents(tab);
    } catch (err) {
      if (!silent) content.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  async function renderResidentVisits() {
    const visits = await api('GET', '/api/visits');
    const sorted = [...visits].sort((a, b) => {
      const da = a.visitDate || String(a.createdAt || '').slice(0, 10);
      const db = b.visitDate || String(b.createdAt || '').slice(0, 10);
      return db.localeCompare(da) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
    const pending = sorted.filter((v) => v.status === 'pendiente');
    const others = sorted.filter((v) => v.status !== 'pendiente');

    const card = (v) => {
      const dateLabel = formatReservationDate(v.visitDate || String(v.createdAt || '').slice(0, 10));
      const vehicleBits = [
        v.vehicleModel ? v.vehicleModel : null,
        v.vehiclePlates ? `Placa(s): ${v.vehiclePlates}` : null,
      ].filter(Boolean).join(' · ');
      return `<article class="resv-item visit-item">
        <div class="resv-item-main">
          <div class="resv-item-top">
            <strong class="resv-area">${escapeHtml(v.visitorName)}</strong>
            ${badge(v.status)}
            ${v.hasPet ? '<span class="pet-badge">Con mascota</span>' : ''}
          </div>
          <div class="resv-meta">
            <span>${dateLabel}</span>
            <span class="resv-dot">·</span>
            <span>Doc. ${escapeHtml(v.document)}</span>
            ${v.visitorPhone ? `<span class="resv-dot">·</span><span>${escapeHtml(v.visitorPhone)}</span>` : ''}
          </div>
          ${vehicleBits ? `<p class="resv-notes">${escapeHtml(vehicleBits)}</p>` : ''}
          ${renderPetDetails(v)}
          ${visitTimeline(v)}
        </div>
      </article>`;
    };

    return `<div class="resv-module visit-module">
      <div class="resv-hero visit-hero">
        <div>
          <h2>Mis visitas</h2>
          <p class="resv-hero-sub">Consulta y programa el ingreso de visitantes a tu unidad.</p>
        </div>
        <button type="button" class="btn btn-primary" id="btn-new-visit">Nueva visita</button>
      </div>

      <div id="visit-list-panel">
        <section class="resv-section">
          <div class="resv-section-head">
            <h3>Pendientes de ingreso</h3>
            <span class="resv-count">${pending.length}</span>
          </div>
          ${pending.length
            ? `<div class="resv-list">${pending.map(card).join('')}</div>`
            : '<p class="empty-state resv-empty">No tienes visitas pendientes</p>'}
        </section>

        <section class="resv-section">
          <div class="resv-section-head">
            <h3>Historial</h3>
            <span class="resv-count">${others.length}</span>
          </div>
          ${others.length
            ? `<div class="resv-list">${others.map(card).join('')}</div>`
            : '<p class="empty-state resv-empty">Aún no hay visitas anteriores</p>'}
        </section>
      </div>

      <div id="visit-calendar-panel" class="hidden"></div>
    </div>`;
  }

  async function showVisitCalendar(year, month) {
    const panel = $('#visit-calendar-panel');
    const list = $('#visit-list-panel');
    if (!panel || !list) return;

    if (!year || !month) {
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }

    hide(list);
    show(panel);
    panel.innerHTML = '<p class="resv-loading">Cargando calendario...</p>';

    let calendarData;
    try {
      calendarData = await api('GET', `/api/visits/calendar?year=${year}&month=${month}`);
    } catch (err) {
      panel.innerHTML = `<p class="error">${err.message}</p>
        <button type="button" class="btn btn-secondary" id="btn-back-visits">Volver</button>`;
      $('#btn-back-visits').onclick = hideVisitCalendar;
      return;
    }

    const booked = {};
    (calendarData.days || []).forEach((d) => { booked[d.date] = d; });
    visitCalendar = { year, month, booked };
    panel.innerHTML = renderVisitCalendarMarkup(year, month, booked);
    bindVisitCalendarEvents();
  }

  function hideVisitCalendar() {
    const panel = $('#visit-calendar-panel');
    const list = $('#visit-list-panel');
    if (panel) hide(panel);
    if (list) show(list);
  }

  function renderVisitCalendarMarkup(year, month, booked) {
    const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('es-CO', {
      month: 'long',
      year: 'numeric',
    });
    const firstDow = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = localToday();
    const weekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

    let cells = '';
    for (let i = 0; i < firstDow; i++) {
      cells += '<div class="cal-cell cal-empty"></div>';
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const info = booked[dateStr];
      const isPast = dateStr < today;
      const isToday = dateStr === today;
      const classes = [
        'cal-cell',
        'cal-day',
        isPast ? 'is-past' : 'is-selectable',
        isToday ? 'is-today' : '',
        info ? 'has-booking' : '',
      ].filter(Boolean).join(' ');
      const title = info
        ? `${info.count} visita(s) programada(s)`
        : (isPast ? 'Día no disponible' : 'Disponible para registrar visita');
      cells += `<button type="button" class="${classes}" data-visit-cal-date="${dateStr}"
        ${isPast ? 'disabled' : ''} title="${title}">
        <span class="cal-day-num">${day}</span>
        ${info ? `<span class="cal-mark" aria-hidden="true"></span>
          <span class="cal-count">${info.count}</span>` : ''}
      </button>`;
    }

    return `<div class="resv-calendar-shell">
      <div class="resv-calendar-toolbar">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-back-visits">← Mis visitas</button>
        <div class="cal-nav">
          <button type="button" class="btn btn-secondary btn-sm" id="visit-cal-prev" aria-label="Mes anterior">‹</button>
          <h3 class="cal-month-title">${monthLabel}</h3>
          <button type="button" class="btn btn-secondary btn-sm" id="visit-cal-next" aria-label="Mes siguiente">›</button>
        </div>
        <p class="cal-hint">Selecciona un día para registrar una visita</p>
      </div>
      <div class="cal-legend">
        <span><i class="cal-legend-dot available"></i> Disponible</span>
        <span><i class="cal-legend-dot booked"></i> Con visita</span>
        <span><i class="cal-legend-dot today"></i> Hoy</span>
      </div>
      <div class="cal-grid">
        ${weekdays.map((w) => `<div class="cal-weekday">${w}</div>`).join('')}
        ${cells}
      </div>
    </div>`;
  }

  function bindVisitCalendarEvents() {
    const back = $('#btn-back-visits');
    if (back) back.onclick = hideVisitCalendar;

    const prev = $('#visit-cal-prev');
    const next = $('#visit-cal-next');
    if (prev) {
      prev.onclick = () => {
        let { year, month } = visitCalendar;
        month -= 1;
        if (month < 1) { month = 12; year -= 1; }
        showVisitCalendar(year, month);
      };
    }
    if (next) {
      next.onclick = () => {
        let { year, month } = visitCalendar;
        month += 1;
        if (month > 12) { month = 1; year += 1; }
        showVisitCalendar(year, month);
      };
    }

    $$('[data-visit-cal-date]').forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => openVisitModal(btn.dataset.visitCalDate);
    });
  }

  async function openVisitModal(dateStr) {
    const modal = $('#visit-modal');
    if (!modal) return;
    $('#visit-date').value = dateStr;
    $('#visit-date-display').value = formatReservationDate(dateStr);
    $('#visit-name').value = '';
    $('#visit-document').value = '';
    $('#visit-vehicle-model').value = '';
    $('#visit-vehicle-plates').value = '';
    resetVisitPetForm();
    if (currentUser && currentUser.unit) {
      $('#visit-unit-display').value = `Unidad ${currentUser.unit}${currentUser.name ? ` — ${currentUser.name}` : ''}`;
    } else {
      $('#visit-unit-display').value = '';
    }
    hide($('#visit-form-error'));

    const box = $('#visit-day-bookings');
    if (box) {
      box.innerHTML = '<p class="resv-day-loading">Cargando visitas del día...</p>';
      show(box);
    }

    show(modal);
    requestAnimationFrame(() => prepareVisitSignatureCanvas());

    try {
      const dayData = await api('GET', `/api/visits/day?date=${encodeURIComponent(dateStr)}`);
      renderVisitDayBookings(dayData.items || []);
    } catch (err) {
      if (box) {
        box.innerHTML = `<p class="error">${err.message || 'No se pudieron cargar las visitas del día'}</p>`;
        show(box);
      }
    }

    $('#visit-name').focus();
  }

  function resetVisitPetForm() {
    const no = $('#visit-pet-no');
    if (no) no.checked = true;
    const yes = $('#visit-pet-yes');
    if (yes) yes.checked = false;
    hide($('#visit-pet-form'));
    ['#visit-phone', '#visit-entry-time', '#pet-name', '#pet-species-other', '#pet-breed'].forEach((sel) => {
      const el = $(sel);
      if (el) el.value = '';
    });
    $$('input[name="petSpecies"]').forEach((r) => { r.checked = false; });
    $$('input[name="petVaccination"]').forEach((r) => { r.checked = false; });
    $$('input[name="petCard"]').forEach((r) => { r.checked = false; });
    ['#pet-commit-control', '#pet-commit-cleanup', '#pet-commit-rules',
      '#pet-commit-responsibility', '#pet-authorize-data', '#pet-authorize-photo'].forEach((sel) => {
      const el = $(sel);
      if (el) el.checked = false;
    });
    const photo = $('#pet-photo');
    if (photo) photo.value = '';
    const preview = $('#pet-photo-preview');
    if (preview) {
      preview.removeAttribute('src');
      hide(preview);
    }
    hide($('#pet-species-other'));
    visitPetPhotoData = null;
    clearVisitSignaturePad();
  }

  function setVisitPetFormVisible(visible) {
    const form = $('#visit-pet-form');
    if (!form) return;
    if (visible) {
      show(form);
      requestAnimationFrame(() => prepareVisitSignatureCanvas());
    } else {
      hide(form);
    }
  }

  let visitPetPhotoData = null;

  const visitSignaturePad = {
    canvas: null,
    ctx: null,
    drawing: false,
    hasInk: false,
    lastX: 0,
    lastY: 0,
  };

  function prepareVisitSignatureCanvas() {
    const canvas = $('#visit-signature');
    if (!canvas || canvas.closest('.hidden')) return;
    visitSignaturePad.canvas = canvas;
    visitSignaturePad.ctx = canvas.getContext('2d');
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const width = canvas.clientWidth || 560;
    const height = canvas.clientHeight || 160;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    visitSignaturePad.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    visitSignaturePad.ctx.lineCap = 'round';
    visitSignaturePad.ctx.lineJoin = 'round';
    visitSignaturePad.ctx.strokeStyle = '#0f172a';
    visitSignaturePad.ctx.lineWidth = 2.25;
    clearVisitSignaturePad();
  }

  function clearVisitSignaturePad() {
    if (!visitSignaturePad.canvas || !visitSignaturePad.ctx) return;
    const canvas = visitSignaturePad.canvas;
    const cssW = canvas.clientWidth || 560;
    const cssH = canvas.clientHeight || 160;
    visitSignaturePad.ctx.save();
    visitSignaturePad.ctx.setTransform(1, 0, 0, 1, 0, 0);
    visitSignaturePad.ctx.clearRect(0, 0, canvas.width, canvas.height);
    visitSignaturePad.ctx.restore();
    visitSignaturePad.ctx.fillStyle = '#ffffff';
    visitSignaturePad.ctx.fillRect(0, 0, cssW, cssH);
    visitSignaturePad.hasInk = false;
    visitSignaturePad.drawing = false;
    canvas.classList.remove('signing');
  }

  function visitSignaturePoint(e) {
    const canvas = visitSignaturePad.canvas;
    const rect = canvas.getBoundingClientRect();
    const src = e.touches && e.touches[0] ? e.touches[0] : e;
    return { x: src.clientX - rect.left, y: src.clientY - rect.top };
  }

  function startVisitSignature(e) {
    if (!visitSignaturePad.ctx) return;
    e.preventDefault();
    const p = visitSignaturePoint(e);
    visitSignaturePad.drawing = true;
    visitSignaturePad.lastX = p.x;
    visitSignaturePad.lastY = p.y;
    visitSignaturePad.canvas.classList.add('signing');
  }

  function moveVisitSignature(e) {
    if (!visitSignaturePad.drawing || !visitSignaturePad.ctx) return;
    e.preventDefault();
    const p = visitSignaturePoint(e);
    const ctx = visitSignaturePad.ctx;
    ctx.beginPath();
    ctx.moveTo(visitSignaturePad.lastX, visitSignaturePad.lastY);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    visitSignaturePad.lastX = p.x;
    visitSignaturePad.lastY = p.y;
    visitSignaturePad.hasInk = true;
  }

  function endVisitSignature(e) {
    if (!visitSignaturePad.drawing) return;
    if (e) e.preventDefault();
    visitSignaturePad.drawing = false;
  }

  function getVisitSignatureDataUrl() {
    if (!visitSignaturePad.canvas || !visitSignaturePad.hasInk) return null;
    return visitSignaturePad.canvas.toDataURL('image/png');
  }

  function visitMediaUrl(id, kind) {
    const base = `/api/visits/${id}/${kind}`;
    return sessionToken ? `${base}?token=${encodeURIComponent(sessionToken)}` : base;
  }

  function bindVisitMediaButtons() {
    $$('[data-visit-pet-photo]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(
        visitMediaUrl(btn.dataset.visitPetPhoto, 'pet-photo'),
        'Foto de mascota'
      );
    });
    $$('[data-visit-signature]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(
        visitMediaUrl(btn.dataset.visitSignature, 'signature'),
        'Firma del visitante'
      );
    });
  }

  function petSpeciesLabel(pet) {
    if (!pet) return '';
    if (pet.species === 'perro') return 'Perro';
    if (pet.species === 'gato') return 'Gato';
    if (pet.species === 'otra') return pet.speciesOther || 'Otra';
    return pet.species || '';
  }

  function renderPetDetails(v) {
    if (!v.hasPet || !v.pet) return '';
    const p = v.pet;
    return `<div class="pet-details">
      <strong>Mascota:</strong> ${escapeHtml(p.name)}
      (${escapeHtml(petSpeciesLabel(p))}${p.breed ? ` · ${escapeHtml(p.breed)}` : ''})<br>
      <small>Vacunación vigente: ${p.vaccinationCurrent ? 'Sí' : 'No'} · Carné: ${p.presentsVaccinationCard ? 'Sí' : 'No'}</small>
      <div class="btn-group" style="margin-top:.4rem">
        ${v.hasPetPhoto ? `<button type="button" class="btn btn-sm" data-visit-pet-photo="${v.id}">Ver foto mascota</button>` : ''}
        ${v.hasVisitorSignature && currentUser && currentUser.role !== 'staff'
          ? `<button type="button" class="btn btn-sm" data-visit-signature="${v.id}">Ver firma</button>`
          : ''}
      </div>
    </div>`;
  }

  function renderVisitDayBookings(items) {
    const box = $('#visit-day-bookings');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<div class="resv-day-empty">
        <strong>Sin visitas este día</strong>
        <span>Puedes registrar el visitante para esta fecha.</span>
      </div>`;
      show(box);
      return;
    }

    box.innerHTML = `<div class="resv-day-head">
        <strong>Visitas ya registradas</strong>
        <span>${items.length}</span>
      </div>
      <ul class="resv-day-list">
        ${items.map((item) => `<li class="resv-day-item">
          <div class="resv-day-item-top">
            <strong>${escapeHtml(item.visitorName)}</strong>
            ${badge(item.status)}
            ${item.hasPet ? '<span class="pet-badge">Con mascota</span>' : ''}
          </div>
          <div class="resv-day-item-meta">
            <span>Doc. ${escapeHtml(item.document)}</span>
            ${item.vehicleModel ? `<span class="resv-dot">·</span><span>${escapeHtml(item.vehicleModel)}</span>` : ''}
            ${item.vehiclePlates ? `<span class="resv-dot">·</span><span>${escapeHtml(item.vehiclePlates)}</span>` : ''}
          </div>
        </li>`).join('')}
      </ul>`;
    show(box);
  }

  function closeVisitModal() {
    const modal = $('#visit-modal');
    if (modal) hide(modal);
    const form = $('#form-visit-modal');
    if (form) form.reset();
    resetVisitPetForm();
    hide($('#visit-form-error'));
  }

  function bindVisitModalEvents() {
    $$('[data-close-visit-modal]').forEach((el) => {
      el.onclick = closeVisitModal;
    });

    $$('input[name="hasPet"]').forEach((radio) => {
      if (radio.dataset.bound) return;
      radio.dataset.bound = '1';
      radio.onchange = () => setVisitPetFormVisible(radio.value === 'yes' && radio.checked);
    });

    $$('input[name="petSpecies"]').forEach((radio) => {
      if (radio.dataset.bound) return;
      radio.dataset.bound = '1';
      radio.onchange = () => {
        const other = $('#pet-species-other');
        if (!other) return;
        if (radio.value === 'otra' && radio.checked) show(other);
        else if (!$('input[name="petSpecies"][value="otra"]:checked')) hide(other);
      };
    });

    const clearSig = $('#clear-visit-signature');
    if (clearSig && !clearSig.dataset.bound) {
      clearSig.dataset.bound = '1';
      clearSig.onclick = () => clearVisitSignaturePad();
    }

    const canvas = $('#visit-signature');
    if (canvas && !canvas.dataset.bound) {
      canvas.dataset.bound = '1';
      canvas.addEventListener('mousedown', startVisitSignature);
      canvas.addEventListener('mousemove', moveVisitSignature);
      canvas.addEventListener('mouseup', endVisitSignature);
      canvas.addEventListener('mouseleave', endVisitSignature);
      canvas.addEventListener('touchstart', startVisitSignature, { passive: false });
      canvas.addEventListener('touchmove', moveVisitSignature, { passive: false });
      canvas.addEventListener('touchend', endVisitSignature, { passive: false });
      canvas.addEventListener('touchcancel', endVisitSignature, { passive: false });
    }

    const photoInput = $('#pet-photo');
    if (photoInput && !photoInput.dataset.bound) {
      photoInput.dataset.bound = '1';
      photoInput.onchange = async () => {
        const file = photoInput.files && photoInput.files[0];
        if (!file) {
          visitPetPhotoData = null;
          hide($('#pet-photo-preview'));
          return;
        }
        visitPetPhotoData = await compressImage(file, 800, 0.72);
        const preview = $('#pet-photo-preview');
        if (preview) {
          preview.src = visitPetPhotoData;
          show(preview);
        }
      };
    }

    const form = $('#form-visit-modal');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.onsubmit = async (e) => {
        e.preventDefault();
        const errEl = $('#visit-form-error');
        hide(errEl);
        const visitDate = $('#visit-date').value;
        const visitorName = $('#visit-name').value.trim();
        const documentId = $('#visit-document').value.trim();
        const vehicleModel = $('#visit-vehicle-model').value.trim();
        const vehiclePlates = $('#visit-vehicle-plates').value.trim();
        const hasPet = $('#visit-pet-yes') && $('#visit-pet-yes').checked;
        if (!visitDate || !visitorName || !documentId) return;

        const payload = {
          visitDate,
          visitorName,
          document: documentId,
          vehicleModel,
          vehiclePlates,
          hasPet: false,
        };

        if (hasPet) {
          const speciesEl = $('input[name="petSpecies"]:checked');
          const vacEl = $('input[name="petVaccination"]:checked');
          const cardEl = $('input[name="petCard"]:checked');
          const signature = getVisitSignatureDataUrl();
          const phone = $('#visit-phone').value.trim();
          const petName = $('#pet-name').value.trim();
          const species = speciesEl ? speciesEl.value : '';
          const speciesOther = $('#pet-species-other').value.trim();

          if (!phone) {
            errEl.textContent = 'Teléfono de contacto requerido';
            show(errEl);
            return;
          }
          if (!petName || !species) {
            errEl.textContent = 'Complete el nombre y la especie de la mascota';
            show(errEl);
            return;
          }
          if (species === 'otra' && !speciesOther) {
            errEl.textContent = 'Indique la especie de la mascota';
            show(errEl);
            return;
          }
          if (!vacEl || !cardEl) {
            errEl.textContent = 'Responda las preguntas de vacunación';
            show(errEl);
            return;
          }
          const commits = [
            '#pet-commit-control', '#pet-commit-cleanup', '#pet-commit-rules',
            '#pet-commit-responsibility', '#pet-authorize-data', '#pet-authorize-photo',
          ];
          if (commits.some((sel) => !$(sel) || !$(sel).checked)) {
            errEl.textContent = 'Debe aceptar todos los compromisos y autorizaciones';
            show(errEl);
            return;
          }
          if (!signature) {
            errEl.textContent = 'La firma del visitante es obligatoria';
            show(errEl);
            return;
          }

          payload.hasPet = true;
          payload.visitorPhone = phone;
          payload.entryTime = $('#visit-entry-time').value;
          payload.visitorSignature = signature;
          payload.pet = {
            name: petName,
            species,
            speciesOther,
            breed: $('#pet-breed').value.trim(),
            vaccinationCurrent: vacEl.value === 'si',
            presentsVaccinationCard: cardEl.value === 'si',
            commitControl: true,
            commitCleanup: true,
            commitRules: true,
            commitResponsibility: true,
            authorizeData: true,
            authorizePhoto: true,
            photo: visitPetPhotoData,
          };
        }

        try {
          await api('POST', '/api/visits', payload);
          closeVisitModal();
          await loadResidentPanel('res-visits');
          const [y, m] = visitDate.split('-').map(Number);
          await showVisitCalendar(y, m);
        } catch (err) {
          errEl.textContent = err.message || 'No se pudo registrar la visita';
          show(errEl);
        }
      };
    }
  }

  async function renderResidentReservations() {
    const reservations = await api('GET', '/api/reservations');
    const sorted = [...reservations].sort((a, b) => {
      const da = `${a.date} ${a.startTime || ''}`;
      const db = `${b.date} ${b.startTime || ''}`;
      return db.localeCompare(da);
    });
    const pending = sorted.filter((r) => r.status === 'pendiente');
    const others = sorted.filter((r) => r.status !== 'pendiente');

    const card = (r) => `<article class="resv-item">
      <div class="resv-item-main">
        <div class="resv-item-top">
          <strong class="resv-area">${escapeHtml(r.area)}</strong>
          ${badge(r.status)}
        </div>
        <div class="resv-meta">
          <span>${formatReservationDate(r.date)}</span>
          <span class="resv-dot">·</span>
          <span>${escapeHtml(r.startTime)} – ${escapeHtml(r.endTime)}</span>
        </div>
        ${r.notes ? `<p class="resv-notes">${escapeHtml(r.notes)}</p>` : ''}
      </div>
    </article>`;

    return `<div class="resv-module">
      <div class="resv-hero">
        <div>
          <h2>Mis reservas</h2>
          <p class="resv-hero-sub">Consulta tus solicitudes o reserva un área común del conjunto.</p>
        </div>
        <button type="button" class="btn btn-primary" id="btn-new-reservation">Nueva reserva</button>
      </div>

      <div id="reservation-list-panel">
        <section class="resv-section">
          <div class="resv-section-head">
            <h3>Pendientes de aprobación</h3>
            <span class="resv-count">${pending.length}</span>
          </div>
          ${pending.length
            ? `<div class="resv-list">${pending.map(card).join('')}</div>`
            : '<p class="empty-state resv-empty">No tienes reservas pendientes</p>'}
        </section>

        <section class="resv-section">
          <div class="resv-section-head">
            <h3>Historial</h3>
            <span class="resv-count">${others.length}</span>
          </div>
          ${others.length
            ? `<div class="resv-list">${others.map(card).join('')}</div>`
            : '<p class="empty-state resv-empty">Aún no hay reservas anteriores</p>'}
        </section>
      </div>

      <div id="reservation-calendar-panel" class="hidden"></div>
    </div>`;
  }

  function formatReservationDate(dateStr) {
    if (!dateStr) return '-';
    const [y, m, d] = dateStr.split('-').map(Number);
    if (!y || !m || !d) return dateStr;
    return new Date(y, m - 1, d).toLocaleDateString('es-CO', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }

  async function showReservationCalendar(year, month) {
    const panel = $('#reservation-calendar-panel');
    const list = $('#reservation-list-panel');
    if (!panel || !list) return;

    if (!year || !month) {
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }

    hide(list);
    show(panel);
    panel.innerHTML = '<p class="resv-loading">Cargando calendario...</p>';

    let calendarData;
    try {
      calendarData = await api('GET', `/api/reservations/calendar?year=${year}&month=${month}`);
    } catch (err) {
      panel.innerHTML = `<p class="error">${err.message}</p>
        <button type="button" class="btn btn-secondary" id="btn-back-reservations">Volver</button>`;
      $('#btn-back-reservations').onclick = hideReservationCalendar;
      return;
    }

    const booked = {};
    (calendarData.days || []).forEach((d) => { booked[d.date] = d; });
    reservationCalendar = { year, month, booked };

    panel.innerHTML = renderReservationCalendarMarkup(year, month, booked);
    bindReservationCalendarEvents();
  }

  function hideReservationCalendar() {
    const panel = $('#reservation-calendar-panel');
    const list = $('#reservation-list-panel');
    if (panel) hide(panel);
    if (list) show(list);
  }

  function renderReservationCalendarMarkup(year, month, booked) {
    const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('es-CO', {
      month: 'long',
      year: 'numeric',
    });
    const firstDow = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = localToday();
    const weekdays = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

    let cells = '';
    for (let i = 0; i < firstDow; i++) {
      cells += '<div class="cal-cell cal-empty"></div>';
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const info = booked[dateStr];
      const isPast = dateStr < today;
      const isToday = dateStr === today;
      const classes = [
        'cal-cell',
        'cal-day',
        isPast ? 'is-past' : 'is-selectable',
        isToday ? 'is-today' : '',
        info ? 'has-booking' : '',
      ].filter(Boolean).join(' ');
      const title = info
        ? `${info.count} reserva(s): ${info.areas.join(', ')}`
        : (isPast ? 'Día no disponible' : 'Disponible para reservar');
      cells += `<button type="button" class="${classes}" data-cal-date="${dateStr}"
        ${isPast ? 'disabled' : ''} title="${title}">
        <span class="cal-day-num">${day}</span>
        ${info ? `<span class="cal-mark" aria-hidden="true"></span>
          <span class="cal-count">${info.count}</span>` : ''}
      </button>`;
    }

    return `<div class="resv-calendar-shell">
      <div class="resv-calendar-toolbar">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-back-reservations">← Mis reservas</button>
        <div class="cal-nav">
          <button type="button" class="btn btn-secondary btn-sm" id="cal-prev" aria-label="Mes anterior">‹</button>
          <h3 class="cal-month-title">${monthLabel}</h3>
          <button type="button" class="btn btn-secondary btn-sm" id="cal-next" aria-label="Mes siguiente">›</button>
        </div>
        <p class="cal-hint">Selecciona un día para crear tu reserva</p>
      </div>
      <div class="cal-legend">
        <span><i class="cal-legend-dot available"></i> Disponible</span>
        <span><i class="cal-legend-dot booked"></i> Con reserva</span>
        <span><i class="cal-legend-dot today"></i> Hoy</span>
      </div>
      <div class="cal-grid">
        ${weekdays.map((w) => `<div class="cal-weekday">${w}</div>`).join('')}
        ${cells}
      </div>
    </div>`;
  }

  function bindReservationCalendarEvents() {
    const back = $('#btn-back-reservations');
    if (back) back.onclick = hideReservationCalendar;

    const prev = $('#cal-prev');
    const next = $('#cal-next');
    if (prev) {
      prev.onclick = () => {
        let { year, month } = reservationCalendar;
        month -= 1;
        if (month < 1) { month = 12; year -= 1; }
        showReservationCalendar(year, month);
      };
    }
    if (next) {
      next.onclick = () => {
        let { year, month } = reservationCalendar;
        month += 1;
        if (month > 12) { month = 1; year += 1; }
        showReservationCalendar(year, month);
      };
    }

    $$('[data-cal-date]').forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => openReservationModal(btn.dataset.calDate);
    });
  }

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

  function updateReservationAreaNotice() {
    const notice = $('#resv-area-notice');
    const area = $('#resv-area') ? $('#resv-area').value : '';
    if (!notice) return;
    if (DEPOSIT_REQUIRED_AREAS.has(area)) {
      notice.className = 'resv-area-notice is-deposit';
      notice.innerHTML = `<strong>Depósito requerido</strong>
        <span>Una vez realizada la reserva, debes hacer el respectivo depósito en portería para que administración pueda aprobarla.</span>`;
      show(notice);
    } else if (AUTO_APPROVE_AREAS.has(area)) {
      notice.className = 'resv-area-notice is-auto';
      notice.innerHTML = `<strong>Aprobación automática</strong>
        <span>Esta área se aprueba al instante al confirmar la reserva.</span>`;
      show(notice);
    } else {
      notice.innerHTML = '';
      hide(notice);
    }
  }

  async function openReservationModal(dateStr) {
    const modal = $('#reservation-modal');
    if (!modal) return;
    $('#resv-date').value = dateStr;
    $('#resv-date-display').value = formatReservationDate(dateStr);
    $('#resv-area').value = '';
    $('#resv-start').value = '09:00';
    $('#resv-end').value = '12:00';
    $('#resv-notes').value = '';
    updateReservationAreaNotice();

    const bookingsBox = $('#resv-day-bookings');
    if (bookingsBox) {
      bookingsBox.innerHTML = '<p class="resv-day-loading">Cargando reservas del día...</p>';
      show(bookingsBox);
    }

    show(modal);

    try {
      const dayData = await api('GET', `/api/reservations/day?date=${encodeURIComponent(dateStr)}`);
      renderDayBookings(dayData.items || []);
    } catch (err) {
      if (bookingsBox) {
        bookingsBox.innerHTML = `<p class="error">${err.message || 'No se pudieron cargar las reservas del día'}</p>`;
        show(bookingsBox);
      }
    }

    $('#resv-area').focus();
  }

  function renderDayBookings(items) {
    const box = $('#resv-day-bookings');
    if (!box) return;
    if (!items.length) {
      box.innerHTML = `<div class="resv-day-empty">
        <strong>Sin reservas este día</strong>
        <span>Puedes solicitar el área y horario que necesites.</span>
      </div>`;
      show(box);
      return;
    }

    box.innerHTML = `<div class="resv-day-head">
        <strong>Ya reservado este día</strong>
        <span>${items.length} reserva${items.length === 1 ? '' : 's'}</span>
      </div>
      <ul class="resv-day-list">
        ${items.map((item) => `<li class="resv-day-item">
          <div class="resv-day-item-top">
            <strong>${item.area}</strong>
            ${badge(item.status)}
          </div>
          <div class="resv-day-item-meta">
            <span>${item.startTime} – ${item.endTime}</span>
            <span class="resv-dot">·</span>
            <span>${item.reservedBy}</span>
            <span class="resv-dot">·</span>
            <span>Unidad ${item.unit}</span>
          </div>
        </li>`).join('')}
      </ul>
      <p class="resv-day-note">No podrás reservar el mismo área en un horario que se cruce con alguno de estos.</p>`;
    show(box);
  }

  function closeReservationModal() {
    const modal = $('#reservation-modal');
    if (modal) hide(modal);
    const form = $('#form-reservation');
    if (form) form.reset();
    updateReservationAreaNotice();
  }

  function bindReservationModalEvents() {
    $$('[data-close-reservation-modal]').forEach((el) => {
      el.onclick = closeReservationModal;
    });

    const areaSelect = $('#resv-area');
    if (areaSelect && !areaSelect.dataset.boundNotice) {
      areaSelect.dataset.boundNotice = '1';
      areaSelect.onchange = updateReservationAreaNotice;
    }

    const form = $('#form-reservation');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.onsubmit = async (e) => {
        e.preventDefault();
        const area = $('#resv-area').value;
        const date = $('#resv-date').value;
        const startTime = $('#resv-start').value;
        const endTime = $('#resv-end').value;
        const notes = $('#resv-notes').value.trim();
        if (!area || !date || !startTime || !endTime) return;
        if (endTime <= startTime) {
          alert('La hora de fin debe ser posterior a la de inicio');
          return;
        }
        try {
          const created = await api('POST', '/api/reservations', { area, date, startTime, endTime, notes });
          closeReservationModal();
          if (created.message) alert(created.message);
          await loadResidentPanel('res-reservations');
          const [y, m] = date.split('-').map(Number);
          await showReservationCalendar(y, m);
        } catch (err) {
          alert(err.message || 'No se pudo crear la reserva');
        }
      };
    }
  }

  async function renderResidentCorrespondence() {
    const items = await api('GET', '/api/correspondence');
    const sorted = [...items].sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    const pending = sorted.filter((c) => (c.status || 'recibido') !== 'entregado');
    const delivered = sorted.filter((c) => c.status === 'entregado');

    const list = (arr) => arr.length
      ? `<div class="resv-list">${arr.map((c) => renderCorrespondenceCard(c, { residentView: true })).join('')}</div>`
      : null;

    return `<div class="resv-module corr-resident-module">
      <div class="resv-hero corr-resident-hero">
        <div>
          <h2>Correspondencia Recibida</h2>
          <p class="resv-hero-sub">Paquetes y correspondencia registrados por vigilancia para tu unidad.</p>
        </div>
        <span class="ann-hero-count">${sorted.length} registro${sorted.length === 1 ? '' : 's'}</span>
      </div>

      <section class="resv-section">
        <div class="resv-section-head">
          <h3>Pendientes de entrega</h3>
          <span class="resv-count">${pending.length}</span>
        </div>
        ${list(pending) || '<p class="empty-state resv-empty">No tienes correspondencia pendiente</p>'}
      </section>

      <section class="resv-section">
        <div class="resv-section-head">
          <h3>Entregadas</h3>
          <span class="resv-count">${delivered.length}</span>
        </div>
        ${list(delivered) || '<p class="empty-state resv-empty">Aún no hay entregas registradas</p>'}
      </section>
    </div>`;
  }

  async function renderResidentAnnouncements() {
    const announcements = await api('GET', '/api/announcements');
    return renderAnnouncementsBoard(announcements, {
      title: 'Anuncios',
      subtitle: 'Mantente al día con los comunicados de la administración.',
      emptyText: 'Cuando administración publique un aviso, aparecerá aquí.',
    });
  }

  function bindResidentEvents(tab) {
    const btnNewVisit = $('#btn-new-visit');
    if (btnNewVisit) btnNewVisit.onclick = () => showVisitCalendar();

    const btnNew = $('#btn-new-reservation');
    if (btnNew) btnNew.onclick = () => showReservationCalendar();

    $$('[data-corr-photo]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(corrMediaUrl(btn.dataset.corrPhoto, 'photo'), 'Imagen del producto');
    });
    $$('[data-corr-signature]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(corrMediaUrl(btn.dataset.corrSignature, 'signature'), 'Firma de entrega');
    });
    bindVisitMediaButtons();
  }

  // Staff panels
  let selectedResident = null;

  async function loadStaffPanel(tab, options = {}) {
    const { silent = false } = options;
    activeTab = tab;
    activePanelLoader = loadStaffPanel;
    const content = $('#content');
    if (!silent) content.innerHTML = '<p>Cargando...</p>';
    try {
      if (tab === 'sec-visits') content.innerHTML = await renderStaffVisits();
      else if (tab === 'sec-announcements') content.innerHTML = await renderStaffAnnouncements();
      else if (tab === 'sec-reservations') content.innerHTML = await renderStaffReservations();
      else if (tab === 'sec-correspondence') content.innerHTML = await renderStaffCorrespondence();
      else if (tab === 'sec-received') content.innerHTML = await renderStaffReceived();
      bindStaffEvents(tab);
    } catch (err) {
      if (!silent) content.innerHTML = `<p class="error">${err.message}</p>`;
    }
  }

  async function renderStaffVisits() {
    const visits = await api('GET', '/api/visits');
    return `<div class="card"><h2>Visitas</h2>
      ${visits.map((v) => `<div class="card">
        <strong>Unidad ${escapeHtml(v.unit)}</strong> — ${escapeHtml(v.visitorName)} (${escapeHtml(v.document)})
        ${badge(v.status)}
        ${v.hasPet ? '<span class="pet-badge">Con mascota</span>' : ''}<br>
        ${v.visitDate ? `<small>Fecha: ${escapeHtml(v.visitDate)}${v.entryTime ? ` · ${escapeHtml(v.entryTime)}` : ''}</small><br>` : ''}
        ${v.visitorPhone ? `<small>Tel: ${escapeHtml(v.visitorPhone)}</small><br>` : ''}
        ${v.vehicleModel || v.vehiclePlates
          ? `<small>${escapeHtml([v.vehicleModel, v.vehiclePlates].filter(Boolean).join(' · '))}</small><br>`
          : ''}
        ${renderPetDetails(v)}
        <div class="btn-group">
          ${v.status === 'pendiente' ? `<button class="btn btn-success btn-sm" data-visit-status="${v.id}" data-status="ingreso">Ingreso</button>` : ''}
          ${v.status === 'ingreso' ? `<button class="btn btn-warning btn-sm" data-visit-status="${v.id}" data-status="despachado">Despachado</button>` : ''}
        </div>
      </div>`).join('')}
    </div>`;
  }

  async function renderStaffAnnouncements() {
    const announcements = await api('GET', '/api/announcements');
    return renderAnnouncementsBoard(announcements, {
      title: 'Anuncios',
      subtitle: 'Comunicados vigentes para el personal de vigilancia.',
      emptyText: 'No hay anuncios activos en este momento.',
    });
  }

  async function renderStaffReservations() {
    const reservations = await api('GET', '/api/reservations');
    const sorted = [...reservations].sort((a, b) => {
      const da = `${a.date || ''} ${a.startTime || ''}`;
      const db = `${b.date || ''} ${b.startTime || ''}`;
      return db.localeCompare(da);
    });
    return `<div class="card"><h2>Reservas por unidad (solo lectura)</h2>
      ${sorted.length
        ? renderUnitGroups(sorted, (r) => renderReservationCard(r), 'date')
        : '<p class="empty-state">No hay reservas registradas</p>'}
    </div>`;
  }

  async function renderStaffCorrespondence() {
    selectedResident = null;
    return `<div class="card"><h2>Registrar correspondencia</h2>
      <label>Buscar residente
        <input type="text" id="corr-search" placeholder="Nombre o unidad...">
      </label>
      <ul id="corr-results" class="search-results hidden"></ul>
      <div id="corr-selected" class="selected-resident hidden"></div>
      <form id="form-correspondence">
        <label>Descripción <textarea name="description" required></textarea></label>
        <label>Foto <input type="file" id="corr-photo" accept="image/*"></label>
        <img id="corr-preview" class="photo-preview hidden">
        <div class="btn-group"><button type="submit" class="btn btn-primary" id="corr-submit" disabled>Registrar</button></div>
      </form>
    </div>`;
  }

  async function renderStaffReceived() {
    const items = await api('GET', '/api/correspondence');
    const sorted = [...items].sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    return `<div class="card"><h2>Historial de correspondencia</h2>
      ${sorted.length
        ? renderUnitGroups(sorted, (c) => renderCorrespondenceCard(c, { showDeliverButton: true }), 'receivedAt')
        : '<p class="empty-state">No hay correspondencia registrada</p>'}
    </div>`;
  }

  function bindStaffEvents(tab) {
    $$('[data-visit-status]').forEach((btn) => {
      btn.onclick = async () => {
        await api('PATCH', `/api/visits/${btn.dataset.visitStatus}`, { status: btn.dataset.status });
        loadStaffPanel('sec-visits');
      };
    });
    bindVisitMediaButtons();

    const searchInput = $('#corr-search');
    if (searchInput) {
      let debounce;
      searchInput.oninput = () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const q = searchInput.value.trim();
          const results = $('#corr-results');
          if (q.length < 2) { hide(results); return; }
          const data = await api('GET', `/api/residents/search?q=${encodeURIComponent(q)}`);
          if (!data.length) {
            results.innerHTML = '<li>Sin resultados</li>';
          } else {
            results.innerHTML = data.map((r) => `<li>
              <span>${escapeHtml(r.name)} — Unidad ${escapeHtml(r.unit)}</span>
              <button type="button" class="btn btn-primary btn-sm" data-select-resident="${escapeHtml(r.id)}">Seleccionar</button>
            </li>`).join('');
            $$('[data-select-resident]').forEach((btn) => {
              btn.onclick = () => {
                const id = btn.dataset.selectResident;
                selectedResident = data.find((row) => row.id === id) || null;
                if (!selectedResident) return;
                $('#corr-selected').textContent = `Seleccionado: ${selectedResident.name} (Unidad ${selectedResident.unit})`;
                show($('#corr-selected'));
                $('#corr-submit').disabled = false;
                hide(results);
              };
            });
          }
          show(results);
        }, 300);
      };
    }

    const photoInput = $('#corr-photo');
    if (photoInput) {
      photoInput.onchange = async () => {
        const file = photoInput.files[0];
        if (!file) return;
        const compressed = await compressImage(file, 800, 0.7);
        const preview = $('#corr-preview');
        preview.src = compressed;
        show(preview);
        photoInput.dataset.compressed = compressed;
      };
    }

    const formCorr = $('#form-correspondence');
    if (formCorr) formCorr.onsubmit = async (e) => {
      e.preventDefault();
      if (!selectedResident) return;
      const description = formCorr.description.value;
      const photo = photoInput && photoInput.dataset.compressed ? photoInput.dataset.compressed : null;
      await api('POST', '/api/correspondence', { residentId: selectedResident.id, description, photo });
      alert('Correspondencia registrada');
      loadStaffPanel('sec-correspondence');
    };

    $$('[data-corr-photo]').forEach((btn) => {
      btn.onclick = () => openMediaPreview(corrMediaUrl(btn.dataset.corrPhoto, 'photo'), 'Imagen del producto');
    });

    $$('[data-deliver-corr]').forEach((btn) => {
      btn.onclick = () => openDeliverModal(btn.dataset.deliverCorr);
    });
  }

  function bindDeliverModalEvents() {
    $$('[data-close-deliver-modal]').forEach((el) => {
      el.onclick = closeDeliverModal;
    });

    const clearBtn = $('#clear-signature');
    if (clearBtn && !clearBtn.dataset.bound) {
      clearBtn.dataset.bound = '1';
      clearBtn.onclick = () => clearSignaturePad();
    }

    const canvas = $('#deliver-signature');
    if (canvas && !canvas.dataset.bound) {
      canvas.dataset.bound = '1';
      canvas.addEventListener('mousedown', startSignature);
      canvas.addEventListener('mousemove', moveSignature);
      canvas.addEventListener('mouseup', endSignature);
      canvas.addEventListener('mouseleave', endSignature);
      canvas.addEventListener('touchstart', startSignature, { passive: false });
      canvas.addEventListener('touchmove', moveSignature, { passive: false });
      canvas.addEventListener('touchend', endSignature, { passive: false });
      canvas.addEventListener('touchcancel', endSignature, { passive: false });
    }

    const formDeliver = $('#form-deliver');
    if (formDeliver && !formDeliver.dataset.bound) {
      formDeliver.dataset.bound = '1';
      formDeliver.onsubmit = async (e) => {
        e.preventDefault();
        const corrId = $('#deliver-corr-id').value;
        const recipientName = $('#deliver-recipient').value.trim();
        if (!recipientName) return;
        const signature = getSignatureDataUrl();
        if (!signature) {
          alert('La firma de quien recibe es obligatoria');
          return;
        }
        try {
          await api('PATCH', `/api/correspondence/${corrId}/deliver`, { recipientName, signature });
          closeDeliverModal();
          loadStaffPanel('sec-received');
        } catch (err) {
          alert(err.message || 'No se pudo registrar la entrega');
        }
      };
    }
  }

  function compressImage(file, maxWidth, quality) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let w = img.width;
          let h = img.height;
          if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Init
  bindThemeToggle();
  bindPrivacyNotice();
  bindDeliverModalEvents();
  bindMediaPreviewModal();
  bindPasswordChangeModal();
  bindAdminResidentPasswordModal();
  bindReservationModalEvents();
  bindVisitModalEvents();
  (async () => {
    if (await checkSession()) showApp();
    else show($('#login-view'));
  })();
})();
