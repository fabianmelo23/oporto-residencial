const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, '..', 'data', 'test-database.local.json');
const SEED_FILE = path.join(__dirname, '..', 'data', 'database.test-seed.json');

let server;
let baseUrl;
let adminToken;
let residentToken;
let staffToken;

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers['x-session-token'] = token;

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        resolve({ status: res.statusCode, headers: res.headers, data, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function resetTestDb() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  fs.copyFileSync(SEED_FILE, TEST_DB);
}

before(async () => {
  process.env.DATABASE_FILE = TEST_DB;
  process.env.PORT = '0';

  const { resetCache } = require('../src/store');
  const { clearSessions } = require('../src/auth');
  resetCache();
  clearSessions();

  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/auth')];
  delete require.cache[require.resolve('../src/app')];

  resetTestDb();

  const app = require('../src/app');
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

beforeEach(async () => {
  const { clearSessions } = require('../src/auth');
  clearSessions();
  resetTestDb();
  const { resetCache, loadDatabase } = require('../src/store');
  resetCache();
  loadDatabase();

  const adminLogin = await request('POST', '/api/auth/login', {
    username: 'admin',
    password: 'Jandrey26+',
  });
  adminToken = adminLogin.data.token;

  const residentLogin = await request('POST', '/api/auth/login', {
    username: 'juan101',
    password: 'resident123',
  });
  residentToken = residentLogin.data.token;

  const staffLogin = await request('POST', '/api/auth/login', {
    username: 'f.melo',
    password: 'melo123',
  });
  staffToken = staffLogin.data.token;
});

describe('Health', () => {
  it('GET /health returns ok', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
  });
});

describe('Live sync', () => {
  it('returns data revision for authenticated users', async () => {
    const before = await request('GET', '/api/sync', null, adminToken);
    assert.equal(before.status, 200);
    assert.equal(typeof before.data.revision, 'number');

    await request(
      'POST',
      '/api/announcements',
      { title: 'Sync Ping', body: 'Revision bump' },
      adminToken
    );

    const after = await request('GET', '/api/sync', null, adminToken);
    assert.equal(after.status, 200);
    assert.ok(after.data.revision > before.data.revision);
  });
});

describe('Auth flows', () => {
  it('admin login', async () => {
    const res = await request('POST', '/api/auth/login', {
      username: 'admin',
      password: 'Jandrey26+',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.role, 'admin');
    assert.equal(res.data.user.adminLevel, 'super');
    assert.ok(res.data.token);
  });

  it('administracion oporto login', async () => {
    const res = await request('POST', '/api/auth/login', {
      username: 'administracionoporto',
      password: 'oporto123',
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.token);
    assert.equal(res.data.user.role, 'admin');
    assert.equal(res.data.user.adminLevel, 'admin');
    assert.equal(res.data.user.name, 'Administración Oporto');
  });

  it('administracion oporto cannot delete visits staff or clear correspondence', async () => {
    const login = await request('POST', '/api/auth/login', {
      username: 'administracionoporto',
      password: 'oporto123',
    });
    const token = login.data.token;

    const createdStaff = await request(
      'POST',
      '/api/staff',
      {
        name: 'Temp Vig',
        username: 'tempvigrestrict',
        phone: '3001112233',
        password: 'pass123',
      },
      token
    );
    assert.equal(createdStaff.status, 201);

    const delStaff = await request('DELETE', `/api/staff/${createdStaff.data.id}`, null, token);
    assert.equal(delStaff.status, 403);

    const list = await request('GET', '/api/visits', null, token);
    const visitId = list.data[0] && list.data[0].id;
    assert.ok(visitId);
    const delVisit = await request('DELETE', `/api/visits/${visitId}`, null, token);
    assert.equal(delVisit.status, 403);

    const clear = await request('DELETE', '/api/correspondence', null, token);
    assert.equal(clear.status, 403);
  });

  it('resident login', async () => {
    const res = await request('POST', '/api/auth/login', {
      username: 'juan101',
      password: 'resident123',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.role, 'resident');
    assert.equal(res.data.user.unit, '101');
    assert.equal(res.data.user.mustChangePassword, false);
  });

  it('security login', async () => {
    const res = await request('POST', '/api/auth/login', {
      username: 'f.melo',
      password: 'melo123',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.role, 'staff');
    assert.equal(res.data.user.position, 'Vigilante Recepcion');
  });

  it('blocks staff login when off duty and informs next shift', async () => {
    process.env.ENFORCE_STAFF_DUTY = 'true';
    try {
      await request('PATCH', '/api/staff/staff_y_obando', { name: 'Yeison Obando' }, adminToken);
      await request(
        'POST',
        '/api/guard-shifts/generate',
        { startDate: '2025-06-24', days: 4 },
        adminToken
      );

      mock.timers.enable({ apis: ['Date'], now: new Date(2025, 5, 24, 10, 0) });
      try {
        const onDutyLogin = await request('POST', '/api/auth/login', {
          username: 'y.obando',
          password: 'obando123',
        });
        assert.equal(onDutyLogin.status, 200);
        assert.equal(onDutyLogin.data.user.name, 'Yeison Obando');
      } finally {
        mock.timers.reset();
      }

      mock.timers.enable({ apis: ['Date'], now: new Date(2025, 5, 24, 20, 0) });
      try {
        const denied = await request('POST', '/api/auth/login', {
          username: 'y.obando',
          password: 'obando123',
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.data.code, 'STAFF_OFF_DUTY');
        assert.match(denied.data.error, /No estás en turno/i);
        assert.match(denied.data.error, /puedes iniciar sesión/i);
        assert.ok(denied.data.nextDuty);
        assert.ok(denied.data.nextDuty.startsAt);
      } finally {
        mock.timers.reset();
      }
    } finally {
      delete process.env.ENFORCE_STAFF_DUTY;
    }
  });

  it('GET /api/auth/me', async () => {
    const res = await request('GET', '/api/auth/me', null, adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.data.username, 'admin');
  });

  it('rejects invalid credentials', async () => {
    const res = await request('POST', '/api/auth/login', {
      username: 'admin',
      password: 'wrong',
    });
    assert.equal(res.status, 401);
  });
});

describe('Residents', () => {
  it('admin lists residents', async () => {
    const res = await request('GET', '/api/residents', null, adminToken);
    assert.equal(res.status, 200);
    assert.ok(res.data.length >= 3);
    assert.ok(!res.data[0].passwordHash);
  });

  it('admin creates resident with temp password', async () => {
    const res = await request(
      'POST',
      '/api/residents',
      {
        name: 'Nuevo Residente',
        unit: '404',
        username: 'nuevo404',
        phone: '3000000000',
        tempPassword: 'temp123',
      },
      adminToken
    );
    assert.equal(res.status, 201);
    assert.equal(res.data.unit, '404');
    assert.equal(res.data.mustChangePassword, true);
  });

  it('admin and administracion can reset resident password', async () => {
    const asAdmin = await request(
      'PATCH',
      '/api/residents/res_1/password',
      { password: 'TempNueva1' },
      adminToken
    );
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.data.mustChangePassword, true);

    const loginTemp = await request('POST', '/api/auth/login', {
      username: 'juan101',
      password: 'TempNueva1',
    });
    assert.equal(loginTemp.status, 200);
    assert.equal(loginTemp.data.user.mustChangePassword, true);

    const oportoLogin = await request('POST', '/api/auth/login', {
      username: 'administracionoporto',
      password: 'oporto123',
    });
    assert.equal(oportoLogin.status, 200);

    const asOporto = await request(
      'PATCH',
      '/api/residents/res_1/password',
      { password: 'OportoTemp2' },
      oportoLogin.data.token
    );
    assert.equal(asOporto.status, 200);

    const staffDenied = await request(
      'PATCH',
      '/api/residents/res_1/password',
      { password: 'NoDebe1' },
      staffToken
    );
    assert.equal(staffDenied.status, 403);

    const residentDenied = await request(
      'PATCH',
      '/api/residents/res_1/password',
      { password: 'NoDebe1' },
      residentToken
    );
    assert.equal(residentDenied.status, 403);
  });

  it('resident cannot list all residents', async () => {
    const res = await request('GET', '/api/residents', null, residentToken);
    assert.equal(res.status, 403);
  });
});

describe('Resident first-login password change', () => {
  it('forces password change and unlocks after valid new password', async () => {
    const created = await request(
      'POST',
      '/api/residents',
      {
        name: 'Primer Ingreso',
        unit: '501',
        username: 'primer501',
        phone: '3001112222',
        tempPassword: 'temp123',
      },
      adminToken
    );
    assert.equal(created.status, 201);

    const login = await request('POST', '/api/auth/login', {
      username: 'primer501',
      password: 'temp123',
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.mustChangePassword, true);
    const token = login.data.token;

    const blocked = await request('GET', '/api/visits', null, token);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'MUST_CHANGE_PASSWORD');

    const weak = await request(
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'temp123', newPassword: 'abc' },
      token
    );
    assert.equal(weak.status, 400);

    const noUpper = await request(
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'temp123', newPassword: 'clave12' },
      token
    );
    assert.equal(noUpper.status, 400);

    const noNumber = await request(
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'temp123', newPassword: 'Claveee' },
      token
    );
    assert.equal(noNumber.status, 400);

    const wrongOld = await request(
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'incorrecta', newPassword: 'Clave12' },
      token
    );
    assert.equal(wrongOld.status, 401);

    const changed = await request(
      'POST',
      '/api/auth/change-password',
      { currentPassword: 'temp123', newPassword: 'Clave12' },
      token
    );
    assert.equal(changed.status, 200);
    assert.equal(changed.data.user.mustChangePassword, false);

    const visits = await request('GET', '/api/visits', null, token);
    assert.equal(visits.status, 200);

    const relogin = await request('POST', '/api/auth/login', {
      username: 'primer501',
      password: 'Clave12',
    });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.data.user.mustChangePassword, false);
  });
});

describe('Resident search (security)', () => {
  it('hides phone and email from results', async () => {
    const res = await request('GET', '/api/residents/search?q=juan', null, staffToken);
    assert.equal(res.status, 200);
    assert.ok(res.data.length > 0);
    const item = res.data[0];
    assert.ok(item.name);
    assert.ok(item.unit);
    assert.equal(item.phone, undefined);
    assert.equal(item.email, undefined);
    assert.equal(item.passwordHash, undefined);
  });
});

describe('Visits', () => {
  it('resident sees only their unit visits', async () => {
    const res = await request('GET', '/api/visits', null, residentToken);
    assert.equal(res.status, 200);
    assert.ok(res.data.every((v) => v.unit === '101'));
  });

  it('resident registers visit with vehicle data and calendar marks the day', async () => {
    const createRes = await request(
      'POST',
      '/api/visits',
      {
        visitorName: 'Carlos Visitante',
        document: '1098765432',
        visitDate: '2025-10-15',
        vehicleModel: 'Mazda 3',
        vehiclePlates: 'ABC123, XYZ789',
      },
      residentToken
    );
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.visitDate, '2025-10-15');
    assert.equal(createRes.data.vehicleModel, 'Mazda 3');
    assert.equal(createRes.data.vehiclePlates, 'ABC123, XYZ789');
    assert.equal(createRes.data.purpose, 'Visita');

    const calendar = await request(
      'GET',
      '/api/visits/calendar?year=2025&month=10',
      null,
      residentToken
    );
    assert.equal(calendar.status, 200);
    const day = calendar.data.days.find((d) => d.date === '2025-10-15');
    assert.ok(day);
    assert.ok(day.count >= 1);

    const dayDetail = await request(
      'GET',
      '/api/visits/day?date=2025-10-15',
      null,
      residentToken
    );
    assert.equal(dayDetail.status, 200);
    assert.ok(dayDetail.data.items.some((v) => v.visitorName === 'Carlos Visitante'));
  });

  it('resident registers visit with pet form data', async () => {
    const signature = `data:image/png;base64,${'iVBOR'.padEnd(220, 'A')}`;
    const create = await request(
      'POST',
      '/api/visits',
      {
        visitorName: 'Ana Con Mascota',
        document: '52123456',
        visitDate: '2025-10-20',
        visitorPhone: '3001112233',
        entryTime: '15:30',
        hasPet: true,
        visitorSignature: signature,
        pet: {
          name: 'Rocky',
          species: 'perro',
          breed: 'Labrador',
          vaccinationCurrent: true,
          presentsVaccinationCard: true,
          commitControl: true,
          commitCleanup: true,
          commitRules: true,
          commitResponsibility: true,
          authorizeData: true,
          authorizePhoto: true,
        },
      },
      residentToken
    );
    assert.equal(create.status, 201);
    assert.equal(create.data.hasPet, true);
    assert.equal(create.data.pet.name, 'Rocky');
    assert.equal(create.data.pet.species, 'perro');
    assert.equal(create.data.hasVisitorSignature, true);
    assert.ok(!('visitorSignature' in create.data));
    assert.equal(create.data.purpose, 'Visita con mascota');

    const missingCommit = await request(
      'POST',
      '/api/visits',
      {
        visitorName: 'Sin Compromiso',
        document: '999',
        visitDate: '2025-10-21',
        visitorPhone: '300',
        hasPet: true,
        visitorSignature: signature,
        pet: {
          name: 'Michi',
          species: 'gato',
          vaccinationCurrent: true,
          presentsVaccinationCard: false,
          commitControl: true,
        },
      },
      residentToken
    );
    assert.equal(missingCommit.status, 400);
  });

  it('staff can view pet photo but not visit visitor signature', async () => {
    const signature = `data:image/png;base64,${'iVBOR'.padEnd(220, 'A')}`;
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const create = await request(
      'POST',
      '/api/visits',
      {
        visitorName: 'Visitante Firma Staff',
        document: '888777',
        visitDate: '2025-10-22',
        visitorPhone: '3002223344',
        hasPet: true,
        visitorSignature: signature,
        pet: {
          name: 'Toby',
          species: 'perro',
          breed: 'Mestizo',
          photo: tinyPng,
          vaccinationCurrent: true,
          presentsVaccinationCard: true,
          commitControl: true,
          commitCleanup: true,
          commitRules: true,
          commitResponsibility: true,
          authorizeData: true,
          authorizePhoto: true,
        },
      },
      residentToken
    );
    assert.equal(create.status, 201);
    const visitId = create.data.id;

    const staffList = await request('GET', '/api/visits', null, staffToken);
    assert.equal(staffList.status, 200);
    const staffItem = staffList.data.find((v) => v.id === visitId);
    assert.ok(staffItem);
    assert.equal(staffItem.hasPetPhoto, true);
    assert.equal(staffItem.hasVisitorSignature, false);

    const staffSig = await request('GET', `/api/visits/${visitId}/signature`, null, staffToken);
    assert.equal(staffSig.status, 403);

    const staffPhoto = await request('GET', `/api/visits/${visitId}/pet-photo`, null, staffToken);
    assert.equal(staffPhoto.status, 200);

    const adminSig = await request('GET', `/api/visits/${visitId}/signature`, null, adminToken);
    assert.equal(adminSig.status, 200);

    const residentSig = await request('GET', `/api/visits/${visitId}/signature`, null, residentToken);
    assert.equal(residentSig.status, 200);
  });

  it('staff updates visit status with timeline', async () => {
    const createRes = await request(
      'POST',
      '/api/visits',
      { visitorName: 'Test Visitor', document: '999', purpose: 'Test' },
      residentToken
    );
    const visitId = createRes.data.id;

    const ingreso = await request(
      'PATCH',
      `/api/visits/${visitId}`,
      { status: 'ingreso' },
      staffToken
    );
    assert.equal(ingreso.status, 200);
    assert.equal(ingreso.data.status, 'ingreso');
    assert.ok(ingreso.data.timeline.some((t) => t.status === 'ingreso'));

    const despachado = await request(
      'PATCH',
      `/api/visits/${visitId}`,
      { status: 'despachado' },
      staffToken
    );
    assert.equal(despachado.status, 200);
    assert.equal(despachado.data.status, 'despachado');
  });
});

describe('Reservations', () => {
  it('resident creates pending reservation', async () => {
    const res = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Salón social',
        date: '2025-08-01',
        startTime: '10:00',
        endTime: '12:00',
        notes: 'Reunión familiar',
      },
      residentToken
    );
    assert.equal(res.status, 201);
    assert.equal(res.data.status, 'pendiente');
    assert.equal(res.data.requiresDeposit, true);
    assert.equal(res.data.unit, '101');
    assert.match(res.data.message, /depósito/i);
  });

  it('auto-approves turco televisor and ping pong', async () => {
    const auto = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Turco 1',
        date: '2025-08-03',
        startTime: '08:00',
        endTime: '09:00',
      },
      residentToken
    );
    assert.equal(auto.status, 201);
    assert.equal(auto.data.status, 'aprobada');
    assert.equal(auto.data.requiresDeposit, false);
    assert.match(auto.data.message, /automáticamente/i);

    const tv = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Televisor',
        date: '2025-08-03',
        startTime: '10:00',
        endTime: '11:00',
      },
      residentToken
    );
    assert.equal(tv.status, 201);
    assert.equal(tv.data.status, 'aprobada');
  });

  it('only admin approves reservations', async () => {
    const createRes = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Kiosco 1',
        date: '2025-08-02',
        startTime: '14:00',
        endTime: '16:00',
      },
      residentToken
    );
    assert.equal(createRes.data.status, 'pendiente');
    const id = createRes.data.id;

    const denied = await request('PATCH', `/api/reservations/${id}`, { status: 'aprobada' }, residentToken);
    assert.equal(denied.status, 403);

    const approved = await request('PATCH', `/api/reservations/${id}`, { status: 'aprobada' }, adminToken);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, 'aprobada');
  });

  it('calendar shows booked days for the month', async () => {
    await request(
      'POST',
      '/api/reservations',
      {
        area: 'Piscina',
        date: '2025-08-10',
        startTime: '09:00',
        endTime: '11:00',
      },
      residentToken
    );
    await request(
      'POST',
      '/api/reservations',
      {
        area: 'BBQ',
        date: '2025-08-10',
        startTime: '14:00',
        endTime: '16:00',
      },
      residentToken
    );

    const calendar = await request(
      'GET',
      '/api/reservations/calendar?year=2025&month=8',
      null,
      residentToken
    );
    assert.equal(calendar.status, 200);
    const day = calendar.data.days.find((d) => d.date === '2025-08-10');
    assert.ok(day);
    assert.equal(day.count, 2);
    assert.ok(day.areas.includes('Piscina'));
    assert.ok(day.areas.includes('BBQ'));
  });

  it('day endpoint lists who reserved and blocks overlapping area times', async () => {
    const first = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Turco 1',
        date: '2025-09-12',
        startTime: '10:00',
        endTime: '12:00',
      },
      residentToken
    );
    assert.equal(first.status, 201);

    const day = await request(
      'GET',
      '/api/reservations/day?date=2025-09-12',
      null,
      residentToken
    );
    assert.equal(day.status, 200);
    assert.equal(day.data.items.length, 1);
    assert.equal(day.data.items[0].area, 'Turco 1');
    assert.equal(day.data.items[0].reservedBy, 'Juan Pérez');
    assert.equal(day.data.items[0].startTime, '10:00');
    assert.equal(day.data.items[0].endTime, '12:00');

    const overlap = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Turco 1',
        date: '2025-09-12',
        startTime: '11:00',
        endTime: '13:00',
      },
      residentToken
    );
    assert.equal(overlap.status, 409);
    assert.match(overlap.data.error, /Turco 1/);

    const later = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Turco 1',
        date: '2025-09-12',
        startTime: '12:00',
        endTime: '14:00',
      },
      residentToken
    );
    assert.equal(later.status, 201);

    const otherArea = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Turco 2',
        date: '2025-09-12',
        startTime: '10:30',
        endTime: '11:30',
      },
      residentToken
    );
    assert.equal(otherArea.status, 201);
  });
});

describe('Announcements', () => {
  it('only admin creates announcements', async () => {
    const denied = await request(
      'POST',
      '/api/announcements',
      { title: 'Test', body: 'Body' },
      residentToken
    );
    assert.equal(denied.status, 403);

    const ok = await request(
      'POST',
      '/api/announcements',
      { title: 'Admin Notice', body: 'Important' },
      adminToken
    );
    assert.equal(ok.status, 201);
  });

  it('staff reads announcements', async () => {
    const res = await request('GET', '/api/announcements', null, staffToken);
    assert.equal(res.status, 200);
    assert.ok(res.data.length > 0);
  });
});

describe('Staff CRUD', () => {
  it('creates staff with phone required', async () => {
    const missing = await request(
      'POST',
      '/api/staff',
      { name: 'Sin Tel', username: 'sintel', password: 'pass123' },
      adminToken
    );
    assert.equal(missing.status, 400);

    const ok = await request(
      'POST',
      '/api/staff',
      {
        name: 'Nuevo Vigilante',
        username: 'nuevovig',
        phone: '3112223344',
        position: 'Portería',
        password: 'pass123',
      },
      adminToken
    );
    assert.equal(ok.status, 201);
    assert.equal(ok.data.phone, '3112223344');
  });

  it('edits staff name username phone position', async () => {
    const created = await request(
      'POST',
      '/api/staff',
      {
        name: 'Nuevo Vigilante',
        username: 'nuevovig',
        phone: '3112223344',
        position: 'Portería',
        password: 'pass123',
      },
      adminToken
    );
    const res = await request(
      'PATCH',
      `/api/staff/${created.data.id}`,
      {
        name: 'Vigilante Editado',
        username: 'vigedit',
        phone: '3998877665',
        position: 'Turno Noche',
      },
      adminToken
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.name, 'Vigilante Editado');
    assert.equal(res.data.username, 'vigedit');
    assert.equal(res.data.phone, '3998877665');
  });

  it('patches status and password', async () => {
    const created = await request(
      'POST',
      '/api/staff',
      {
        name: 'Vigilante Editado',
        username: 'vigedit',
        phone: '3112223344',
        position: 'Portería',
        password: 'pass123',
      },
      adminToken
    );
    const member = created.data;

    const status = await request(
      'PATCH',
      `/api/staff/${member.id}/status`,
      { active: false },
      adminToken
    );
    assert.equal(status.data.active, false);

    await request('PATCH', `/api/staff/${member.id}/password`, { password: 'newpass' }, adminToken);

    const loginFail = await request('POST', '/api/auth/login', {
      username: 'vigedit',
      password: 'pass123',
    });
    assert.equal(loginFail.status, 401);

    await request('PATCH', `/api/staff/${member.id}/status`, { active: true }, adminToken);

    const loginOk = await request('POST', '/api/auth/login', {
      username: 'vigedit',
      password: 'newpass',
    });
    assert.equal(loginOk.status, 200);
  });

  it('deletes staff member', async () => {
    const created = await request(
      'POST',
      '/api/staff',
      {
        name: 'A Eliminar',
        username: 'vigdelete',
        phone: '3112223344',
        position: 'Portería',
        password: 'pass123',
      },
      adminToken
    );
    const member = created.data;
    const res = await request('DELETE', `/api/staff/${member.id}`, null, adminToken);
    assert.equal(res.status, 200);
    const after = await request('GET', '/api/staff', null, adminToken);
    assert.ok(!after.data.some((s) => s.id === member.id));
  });

  it('seeded staff can be deleted and does not reappear', async () => {
    const list = await request('GET', '/api/staff', null, adminToken);
    const staffMember = list.data.find((s) => s.username === 'f.melo');
    assert.ok(staffMember);

    const del = await request('DELETE', `/api/staff/${staffMember.id}`, null, adminToken);
    assert.equal(del.status, 200);

    const after = await request('GET', '/api/staff', null, adminToken);
    assert.ok(!after.data.some((s) => s.username === 'f.melo'));

    const { resetCache, loadDatabase } = require('../src/store');
    resetCache();
    loadDatabase();

    const reloaded = await request('GET', '/api/staff', null, adminToken);
    assert.ok(!reloaded.data.some((s) => s.username === 'f.melo'));
  });
});

describe('Correspondence', () => {
  it('registers correspondence with photo', async () => {
    const search = await request('GET', '/api/residents/search?q=juan', null, staffToken);
    const residentId = search.data[0].id;

    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const create = await request(
      'POST',
      '/api/correspondence',
      {
        residentId,
        description: 'Paquete Amazon',
        photo: tinyPng,
      },
      staffToken
    );
    assert.equal(create.status, 201);
    assert.equal(create.data.hasPhoto, true);
    assert.equal(create.data.unit, '101');
    assert.equal(create.data.status, 'recibido');
    assert.equal(create.data.receivedByStaffName, 'Fabian Melo');

    const photo = await request('GET', `/api/correspondence/${create.data.id}/photo`, null, staffToken);
    assert.equal(photo.status, 200);
    assert.match(photo.headers['content-type'], /image/);
  });

  it('lists staff options for deliver dropdown', async () => {
    const res = await request('GET', '/api/staff/options', null, staffToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length > 0);
    assert.ok(res.data.every((s) => s.id && s.name));
  });

  it('marks correspondence as delivered by on-duty guard', async () => {
    await request('PATCH', '/api/staff/staff_y_obando', { name: 'Yeison Obando' }, adminToken);
    await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-24', days: 2 },
      adminToken
    );

    const search = await request('GET', '/api/residents/search?q=juan', null, staffToken);
    const residentId = search.data[0].id;

    const create = await request(
      'POST',
      '/api/correspondence',
      { residentId, description: 'Sobre certificado' },
      staffToken
    );
    assert.equal(create.status, 201);

    // Minimal valid-looking signature payload (base64 length >= 200)
    const signature = `data:image/png;base64,${'iVBOR'.padEnd(220, 'A')}`;

    mock.timers.enable({ apis: ['Date'], now: new Date(2025, 5, 24, 10, 0) });
    try {
      const onDuty = await request('GET', '/api/guard-shifts/on-duty', null, staffToken);
      assert.equal(onDuty.status, 200);
      assert.equal(onDuty.data.staffName, 'Yeison Obando');

      const missingSig = await request(
        'PATCH',
        `/api/correspondence/${create.data.id}/deliver`,
        { recipientName: 'María López' },
        staffToken
      );
      assert.equal(missingSig.status, 400);

      const deliver = await request(
        'PATCH',
        `/api/correspondence/${create.data.id}/deliver`,
        { recipientName: 'María López', signature },
        staffToken
      );
      assert.equal(deliver.status, 200);
      assert.equal(deliver.data.status, 'entregado');
      assert.equal(deliver.data.recipientName, 'María López');
      assert.equal(deliver.data.deliveredByStaffName, 'Yeison Obando');
      assert.equal(deliver.data.hasSignature, false);
      assert.ok(!('signature' in deliver.data));
      assert.ok(deliver.data.deliveredAt);

      const staffSig = await request(
        'GET',
        `/api/correspondence/${create.data.id}/signature`,
        null,
        staffToken
      );
      assert.equal(staffSig.status, 403);

      const adminSig = await request(
        'GET',
        `/api/correspondence/${create.data.id}/signature`,
        null,
        adminToken
      );
      assert.equal(adminSig.status, 200);

      const residentSig = await request(
        'GET',
        `/api/correspondence/${create.data.id}/signature`,
        null,
        residentToken
      );
      assert.equal(residentSig.status, 200);

      const residentList = await request('GET', '/api/correspondence', null, residentToken);
      assert.ok(residentList.data.some((c) => c.id === create.data.id && c.hasSignature === true));

      const duplicate = await request(
        'PATCH',
        `/api/correspondence/${create.data.id}/deliver`,
        { recipientName: 'Otro', signature },
        staffToken
      );
      assert.equal(duplicate.status, 409);
    } finally {
      mock.timers.reset();
    }
  });

  it('resident sees only own correspondence', async () => {
    const search = await request('GET', '/api/residents/search?q=juan', null, staffToken);
    const residentId = search.data[0].id;

    const create = await request(
      'POST',
      '/api/correspondence',
      { residentId, description: 'Caja para residente' },
      staffToken
    );
    assert.equal(create.status, 201);

    const mine = await request('GET', '/api/correspondence', null, residentToken);
    assert.equal(mine.status, 200);
    assert.ok(mine.data.every((c) => c.residentId === 'res_1'));
    assert.ok(mine.data.some((c) => c.description === 'Caja para residente'));
  });

  it('admin can clear correspondence', async () => {
    const res = await request('DELETE', '/api/correspondence', null, adminToken);
    assert.equal(res.status, 200);
    assert.ok(res.data.removed >= 0);
  });
});

describe('Notifications', () => {
  it('creates notifications for admins and staff when resident books', async () => {
    const create = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Kiosco 2',
        date: '2025-11-05',
        startTime: '10:00',
        endTime: '12:00',
      },
      residentToken
    );
    assert.equal(create.status, 201);

    const adminNotifs = await request('GET', '/api/notifications', null, adminToken);
    assert.equal(adminNotifs.status, 200);
    assert.ok(adminNotifs.data.unreadCount > 0);
    assert.ok(adminNotifs.data.items.some((n) => n.category === 'reservations'));

    const staffNotifs = await request('GET', '/api/notifications', null, staffToken);
    assert.equal(staffNotifs.status, 200);
    assert.ok(staffNotifs.data.unreadCount > 0);
    assert.ok(staffNotifs.data.items.some((n) => n.category === 'reservations'));
  });

  it('notifies staff when resident registers a visit', async () => {
    const create = await request(
      'POST',
      '/api/visits',
      {
        visitorName: 'Visitante Notificación',
        document: '11223344',
        visitDate: '2025-11-08',
        vehicleModel: 'Chevrolet Spark',
        vehiclePlates: 'AAA111',
      },
      residentToken
    );
    assert.equal(create.status, 201);

    const staffNotifs = await request('GET', '/api/notifications', null, staffToken);
    assert.equal(staffNotifs.status, 200);
    assert.ok(
      staffNotifs.data.items.some(
        (n) => n.category === 'visits' && n.body.includes('Visitante Notificación')
      )
    );
  });

  it('notifies resident when reservation is approved and can mark as read', async () => {
    const create = await request(
      'POST',
      '/api/reservations',
      {
        area: 'Salón social',
        date: '2025-11-06',
        startTime: '15:00',
        endTime: '17:00',
      },
      residentToken
    );
    assert.equal(create.status, 201);

    const approved = await request(
      'PATCH',
      `/api/reservations/${create.data.id}`,
      { status: 'aprobada' },
      adminToken
    );
    assert.equal(approved.status, 200);

    const notifs = await request('GET', '/api/notifications', null, residentToken);
    assert.equal(notifs.status, 200);
    const item = notifs.data.items.find((n) => n.entityId === create.data.id);
    assert.ok(item);
    assert.match(item.title, /aprobada/i);

    const read = await request('PATCH', `/api/notifications/${item.id}/read`, null, residentToken);
    assert.equal(read.status, 200);
    assert.equal(read.data.read, true);

    const after = await request('GET', '/api/notifications/unread-count', null, residentToken);
    assert.equal(after.status, 200);
    assert.ok(after.data.unreadCount >= 0);
  });

  it('notifies residents and staff when announcement is published', async () => {
    const created = await request(
      'POST',
      '/api/announcements',
      { title: 'Aviso Notificación', body: 'Prueba de campana' },
      adminToken
    );
    assert.equal(created.status, 201);

    const residentNotifs = await request('GET', '/api/notifications', null, residentToken);
    assert.ok(residentNotifs.data.items.some((n) => n.title === 'Nuevo anuncio' && n.body.includes('Aviso Notificación')));

    const staffNotifs = await request('GET', '/api/notifications', null, staffToken);
    assert.ok(staffNotifs.data.items.some((n) => n.category === 'announcements'));
  });
});

describe('Audit log', () => {
  it('filters by actorId category and q', async () => {
    await request(
      'POST',
      '/api/announcements',
      { title: 'Audit Test Unique', body: 'xyz' },
      adminToken
    );

    const all = await request('GET', '/api/audit', null, adminToken);
    assert.ok(all.data.length > 0);

    const byActor = await request('GET', '/api/audit?actorId=admin_1', null, adminToken);
    assert.ok(byActor.data.every((l) => l.actorId === 'admin_1'));

    const byCategory = await request('GET', '/api/audit?category=announcements', null, adminToken);
    assert.ok(byCategory.data.every((l) => l.category === 'announcements'));

    const byQ = await request('GET', '/api/audit?q=Audit Test Unique', null, adminToken);
    assert.ok(byQ.data.some((l) => l.details.includes('Audit Test Unique')));
  });

  it('hides super admin activity from regular admin', async () => {
    await request(
      'POST',
      '/api/announcements',
      { title: 'Super Only Audit Marker', body: 'xyz' },
      adminToken
    );

    const oportoLogin = await request('POST', '/api/auth/login', {
      username: 'administracionoporto',
      password: 'oporto123',
    });
    assert.equal(oportoLogin.status, 200);
    const oportoToken = oportoLogin.data.token;

    const asOporto = await request('GET', '/api/audit', null, oportoToken);
    assert.equal(asOporto.status, 200);
    assert.ok(asOporto.data.every((l) => l.actorId !== 'admin_1'));
    assert.ok(!asOporto.data.some((l) => l.details && l.details.includes('Super Only Audit Marker')));

    const bySuperActor = await request('GET', '/api/audit?actorId=admin_1', null, oportoToken);
    assert.equal(bySuperActor.data.length, 0);

    const asSuper = await request('GET', '/api/audit', null, adminToken);
    assert.ok(asSuper.data.some((l) => l.details && l.details.includes('Super Only Audit Marker')));
  });

  it('includes unit on resident actors in audit', async () => {
    await request(
      'POST',
      '/api/reservations',
      {
        area: 'Turco 1',
        date: '2025-12-20',
        startTime: '09:00',
        endTime: '10:00',
      },
      residentToken
    );

    const logs = await request('GET', '/api/audit', null, adminToken);
    assert.equal(logs.status, 200);
    const residentLog = logs.data.find((l) => l.actorId === 'res_1' && l.actorRole === 'resident');
    assert.ok(residentLog);
    assert.equal(residentLog.actorUnit, '101');
  });
});

describe('Guard shifts', () => {
  it('generates 2x2 rotation schedule as a period', async () => {
    const res = await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-24', days: 6 },
      adminToken
    );
    assert.equal(res.status, 201);
    assert.equal(res.data.startDate, '2025-06-24');
    assert.equal(res.data.endDate, '2025-06-29');
    assert.equal(res.data.shifts.length, 18);

    const day1 = res.data.shifts.filter((s) => s.date === '2025-06-24' && s.type === 'day');
    assert.equal(day1[0].guardName, 'Yeison Obando');
    assert.equal(day1[0].shiftLabel, '1 diurno');

    const night1 = res.data.shifts.filter((s) => s.date === '2025-06-24' && s.type === 'night');
    assert.equal(night1[0].guardName, 'Fabián Melo');
    assert.equal(night1[0].shiftLabel, '1 nocturno');

    const rest1 = res.data.shifts.filter((s) => s.date === '2025-06-24' && s.type === 'rest');
    assert.equal(rest1[0].guardName, 'Jorge Bernal');
    assert.equal(rest1[0].shiftLabel, '1 descanso');

    const day28 = res.data.shifts.filter((s) => s.date === '2025-06-28' && s.type === 'day');
    assert.equal(day28[0].guardName, 'Fabián Melo');
    assert.equal(day28[0].shiftLabel, '1 diurno');
  });

  it('continues rotation in a new period after the previous one', async () => {
    await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-24', days: 7 },
      adminToken
    );

    const july = await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-07-01', days: 7 },
      adminToken
    );
    assert.equal(july.status, 201);
    assert.equal(july.data.startDate, '2025-07-01');
    assert.equal(july.data.endDate, '2025-07-07');

    const dayJuly1 = july.data.shifts.filter((s) => s.date === '2025-07-01' && s.type === 'day');
    assert.equal(dayJuly1[0].guardName, 'Yeison Obando');
    assert.equal(dayJuly1[0].shiftLabel, '2 diurno');

    const list = await request('GET', '/api/guard-shifts', null, adminToken);
    assert.equal(list.data.periods.length, 2);
    assert.equal(list.data.suggestedStartDate, '2025-07-08');
    assert.equal(list.data.guardShiftAnchor, '2025-06-24');
  });

  it('rejects overlapping periods', async () => {
    await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-24', days: 7 },
      adminToken
    );
    const overlap = await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-28', days: 5 },
      adminToken
    );
    assert.equal(overlap.status, 409);
  });

  it('CSV includes hours for a period', async () => {
    const created = await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-24', days: 2 },
      adminToken
    );
    const res = await request(
      'GET',
      `/api/guard-shifts.csv?periodId=${created.data.id}`,
      null,
      adminToken
    );
    assert.equal(res.status, 200);
    assert.match(res.text, /Horas/);
    assert.match(res.text, /1 diurno/);
    assert.match(res.text, /1 nocturno/);
    assert.match(res.text, /1 descanso/);
  });

  it('admin can delete a single period', async () => {
    const first = await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-24', days: 2 },
      adminToken
    );
    await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-06-28', days: 2 },
      adminToken
    );

    const res = await request('DELETE', `/api/guard-shifts/${first.data.id}`, null, adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.data.period.id, first.data.id);

    const after = await request('GET', '/api/guard-shifts', null, adminToken);
    assert.equal(after.data.periods.length, 1);
    assert.equal(after.data.periods[0].startDate, '2025-06-28');
    assert.equal(after.data.guardShiftAnchor, '2025-06-24');
  });

  it('resets anchor when last period is deleted', async () => {
    const created = await request(
      'POST',
      '/api/guard-shifts/generate',
      { startDate: '2025-09-01', days: 2 },
      adminToken
    );
    await request('DELETE', `/api/guard-shifts/${created.data.id}`, null, adminToken);
    const after = await request('GET', '/api/guard-shifts', null, adminToken);
    assert.equal(after.data.periods.length, 0);
    assert.equal(after.data.guardShiftAnchor, null);
  });
});

describe('Auto next-month guard shifts', () => {
  const {
    ensureNextMonthGuardShiftPeriod,
    createGuardShiftPeriod,
    generateGuardShiftSchedule,
    getDaysLeftInMonth,
    getNextCalendarMonthRange,
  } = require('../src/store');

  it('skips when more than 1 day remains in the month', () => {
    const now = new Date(2025, 5, 15); // 15 Jun, month has 30 days → 15 left
    assert.ok(getDaysLeftInMonth(now) > 1);
    const db = { guardShiftPeriods: [], guardShiftAnchor: '2025-06-01' };
    const result = ensureNextMonthGuardShiftPeriod(db, now);
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'not_near_month_end');
    assert.equal(db.guardShiftPeriods.length, 0);
  });

  it('skips when no schedule exists yet', () => {
    const now = new Date(2025, 5, 29); // 29 Jun → 1 day left
    assert.equal(getDaysLeftInMonth(now), 1);
    const db = { guardShiftPeriods: [], guardShiftAnchor: null };
    const result = ensureNextMonthGuardShiftPeriod(db, now);
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'no_existing_schedule');
  });

  it('generates next month schedule when 1 day remains and it is missing', () => {
    const now = new Date(2025, 5, 29); // 29 Jun 2025
    const next = getNextCalendarMonthRange(now);
    assert.equal(next.startDate, '2025-07-01');
    assert.equal(next.endDate, '2025-07-31');
    assert.equal(next.days, 31);

    const juneShifts = generateGuardShiftSchedule('2025-06-01', 30, 0);
    const db = {
      guardShiftAnchor: '2025-06-01',
      guardShiftPeriods: [createGuardShiftPeriod(juneShifts, '2025-06-01', '2025-06-30')],
    };

    const result = ensureNextMonthGuardShiftPeriod(db, now);
    assert.equal(result.action, 'created');
    assert.equal(result.startDate, '2025-07-01');
    assert.equal(result.endDate, '2025-07-31');
    assert.equal(result.days, 31);
    assert.equal(db.guardShiftPeriods.length, 2);
    assert.equal(db.guardShiftPeriods[1].startDate, '2025-07-01');
    assert.equal(db.guardShiftPeriods[1].endDate, '2025-07-31');
  });

  it('does nothing if next month is already covered', () => {
    const now = new Date(2025, 5, 30); // last day of June
    assert.equal(getDaysLeftInMonth(now), 0);

    const juneShifts = generateGuardShiftSchedule('2025-06-01', 30, 0);
    const julyShifts = generateGuardShiftSchedule('2025-07-01', 31, 30);
    const db = {
      guardShiftAnchor: '2025-06-01',
      guardShiftPeriods: [
        createGuardShiftPeriod(juneShifts, '2025-06-01', '2025-06-30'),
        createGuardShiftPeriod(julyShifts, '2025-07-01', '2025-07-31'),
      ],
    };

    const result = ensureNextMonthGuardShiftPeriod(db, now);
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'already_exists');
    assert.equal(db.guardShiftPeriods.length, 2);
  });

  it('also generates on the last day of the month if still missing', () => {
    const now = new Date(2025, 6, 31); // 31 Jul
    assert.equal(getDaysLeftInMonth(now), 0);
    const julyShifts = generateGuardShiftSchedule('2025-07-01', 31, 0);
    const db = {
      guardShiftAnchor: '2025-07-01',
      guardShiftPeriods: [createGuardShiftPeriod(julyShifts, '2025-07-01', '2025-07-31')],
    };
    const result = ensureNextMonthGuardShiftPeriod(db, now);
    assert.equal(result.action, 'created');
    assert.equal(result.startDate, '2025-08-01');
    assert.equal(result.endDate, '2025-08-31');
  });
});

describe('Staff duty login gate', () => {
  const {
    evaluateStaffLoginAccess,
    generateGuardShiftSchedule,
    createGuardShiftPeriod,
  } = require('../src/store');

  it('allows login when schedule is empty', () => {
    const access = evaluateStaffLoginAccess([], 'Yeison Obando', new Date(2025, 5, 24, 10, 0));
    assert.equal(access.allowed, true);
  });

  it('allows only the active day guard during day hours', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 10, 0);

    const dayGuard = evaluateStaffLoginAccess(periods, 'Yeison Obando', now);
    assert.equal(dayGuard.allowed, true);

    const nightGuard = evaluateStaffLoginAccess(periods, 'Fabián Melo', now);
    assert.equal(nightGuard.allowed, false);
    assert.match(nightGuard.message, /18:00/);

    const restGuard = evaluateStaffLoginAccess(periods, 'Jorge Bernal', now);
    assert.equal(restGuard.allowed, false);
  });
});

describe('Staff current shift', () => {
  const {
    getCurrentGuardShift,
    generateGuardShiftSchedule,
    createGuardShiftPeriod,
  } = require('../src/store');

  it('detects active day shift', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 10, 0);
    const shift = getCurrentGuardShift(periods, 'Yeison Obando', now);
    assert.equal(shift.shiftLabel, '1 diurno');
    assert.equal(shift.schedule, '07:00 a 18:00');
  });

  it('detects rest day on off hours', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 10, 0);
    const shift = getCurrentGuardShift(periods, 'Jorge Bernal', now);
    assert.equal(shift.shiftLabel, '1 descanso');
    assert.equal(shift.type, 'rest');
  });

  it('shows scheduled night shift before it starts', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 10, 0);
    const shift = getCurrentGuardShift(periods, 'Fabian Melo', now);
    assert.equal(shift.shiftLabel, '1 nocturno');
    assert.match(shift.schedule, /18:00/);
  });

  it('matches guard name without accents during night hours', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 20, 0);
    const shift = getCurrentGuardShift(periods, 'Fabian Melo', now);
    assert.equal(shift.shiftLabel, '1 nocturno');
    assert.match(shift.schedule, /18:00/);
  });
});

describe('On-duty guard', () => {
  const {
    getOnDutyGuard,
    generateGuardShiftSchedule,
    createGuardShiftPeriod,
  } = require('../src/store');

  it('returns day guard during day shift hours', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 10, 0);
    const onDuty = getOnDutyGuard(periods, now);
    assert.equal(onDuty.guardName, 'Yeison Obando');
    assert.equal(onDuty.shiftLabel, '1 diurno');
  });

  it('returns night guard during night shift hours', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 20, 0);
    const onDuty = getOnDutyGuard(periods, now);
    assert.equal(onDuty.guardName, 'Fabián Melo');
    assert.equal(onDuty.shiftLabel, '1 nocturno');
  });

  it('returns null outside shift hours', () => {
    const shifts = generateGuardShiftSchedule('2025-06-24', 2, 0);
    const periods = [createGuardShiftPeriod(shifts, '2025-06-24', '2025-06-25')];
    const now = new Date(2025, 5, 24, 6, 30);
    const onDuty = getOnDutyGuard(periods, now);
    assert.equal(onDuty, null);
  });
});

describe('Payments and maintenance', () => {
  it('admin creates payment', async () => {
    const res = await request(
      'POST',
      '/api/payments',
      {
        unit: '303',
        concept: 'Admin Julio',
        amount: 250000,
        dueDate: '2025-07-05',
      },
      adminToken
    );
    assert.equal(res.status, 201);
  });

  it('resident sees scoped payments', async () => {
    const res = await request('GET', '/api/payments', null, residentToken);
    assert.ok(res.data.every((p) => p.unit === '101'));
  });
});
