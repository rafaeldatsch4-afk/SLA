const db = require('../lib/db');
const auth = require('../lib/auth');
const T = require('../lib/trips');
const enc = require('../lib/crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = m => new HttpError(400, m);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const str = (v, max, name, { required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw bad(`Campo obrigatório: ${name}.`);
  if (s.length > max) throw bad(`Campo muito longo: ${name}.`);
  return s;
};
const intId = (v, name = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw bad(`${name} inválido.`);
  return n;
};
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw bad(`Valor inválido para ${name}.`);
  return v;
};

const TRIP_STATUS = ['Programada', 'Em andamento', 'Concluída', 'Cancelada'];
const FLEET_STATUS = ['Disponível', 'Em viagem', 'Na oficina', 'Em manutenção'];
const FLEET_IDS = ['6106', '7107', '8108', 'VH-101', 'VH-204', 'VH-305', 'VH-406', 'VH-407'];

function resToJson(r) {
  return {
    code: r.code, from: r.from_city, to: r.to_city, date: r.travel_date, depart: r.depart, arrive: r.arrive,
    seat: String(r.seat).padStart(2, '0'), price: r.price, tripId: r.trip_id, bus: r.bus, box: r.box || 'A confirmar', status: r.status,
  };
}

const kvGet = async key => (await db.query('select value from kv where key=$1', [key])).rows[0]?.value || {};
const kvSet = (key, value) => db.query(
  'insert into kv(key,value) values($1,$2) on conflict (key) do update set value=excluded.value', [key, JSON.stringify(value)]);

const requireOwner = async req => {
  const s = await auth.getSession(req);
  if (!s || s.role !== 'owner') throw new HttpError(401, 'Acesso restrito ao administrador.');
  return s;
};
const requireDriver = async req => {
  const s = await auth.getSession(req);
  if (!s || s.role !== 'driver') throw new HttpError(401, 'Acesso restrito a motoristas aprovados.');
  return s;
};
const requireStaff = async req => {
  const s = await auth.getSession(req);
  if (!s) throw new HttpError(401, 'Faça login na área da equipe.');
  return s;
};

function driverTripJson(t) {
  return { id: t.id, from: t.from_city, to: t.to_city, date: t.trip_date, hour: t.hour, mode: t.mode, driver: t.driver, status: t.status };
}

// registra a falha e avisa quantas tentativas restam antes do bloqueio de 15 minutos
async function loginFailed(ip, msg) {
  await auth.registerFailure(ip);
  const left = await auth.failuresLeft(ip);
  throw new HttpError(401, left > 0 ? `${msg} Restam ${left} tentativa(s) antes do bloqueio.` : `${msg} Limite de tentativas atingido: aguarde 15 minutos.`);
}

const routes = {
  // ---------- público ----------
  'GET /health': async () => { await db.query('select 1'); return { ok: true }; },

  'GET /me': async ({ req }) => {
    const s = await auth.getSession(req);
    return s ? { role: s.role, name: s.name || null, id: s.id || null } : { role: null };
  },

  'GET /trips': async ({ query }) => {
    const date = T.validDate(query.date) ? query.date : T.todayBR();
    const { rows } = await db.query('select * from trips order by sort_order');
    return { trips: await T.withAvailability(rows.map(T.rowToTrip), date), date };
  },

  'GET /search': async ({ query }) => {
    const from = str(query.from, 60, 'origem'), to = str(query.to, 60, 'destino');
    if (!T.validCity(from) || !T.validCity(to)) throw bad('Nome de cidade inválido.');
    if (T.normCity(from) === T.normCity(to)) throw bad('Escolha uma origem e um destino diferentes.');
    if (!T.validDate(query.date) || query.date < T.todayBR()) throw bad('Escolha uma data a partir de hoje.');
    return { trips: await T.searchTrips(from, to, query.date) };
  },

  'GET /seats': async ({ query }) => {
    const trip = await T.resolveTrip(query.trip);
    if (!trip) throw new HttpError(404, 'Viagem não encontrada.');
    if (!T.validDate(query.date)) throw bad('Data inválida.');
    return { seats: trip.seats, taken: await T.takenSeats(trip, query.date) };
  },

  'POST /reservations': async ({ req, body }) => {
    const trip = await T.resolveTrip(body.tripId);
    if (!trip) throw new HttpError(404, 'Viagem não encontrada.');
    if (!T.validDate(body.date) || body.date < T.todayBR()) throw bad('Data inválida.');
    const clientId = str(body.clientId, 64, 'clientId');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(clientId)) throw bad('clientId inválido.');
    const seats = [...new Set((Array.isArray(body.seats) ? body.seats : []).map(Number))];
    if (!seats.length || seats.length > 4) throw bad('Escolha de 1 a 4 poltronas.');
    if (seats.some(n => !Number.isInteger(n) || n < 1 || n > trip.seats)) throw bad('Poltrona inválida.');
    const base = T.baseTaken(trip);
    if (seats.some(n => base.includes(n))) throw new HttpError(409, 'Alguma poltrona acabou de ser ocupada. Escolha novamente.');
    const ip = auth.clientIp(req);
    const recent = (await db.query(`select count(*)::int n from reservations where ip=$1 and created_at > now() - interval '1 hour'`, [ip])).rows[0].n;
    if (recent + seats.length > 40) throw new HttpError(429, 'Muitas reservas em pouco tempo. Tente mais tarde.');
    try {
      const created = await db.tx(async c => {
        const out = [];
        for (const seat of seats.sort((a, b) => a - b)) {
          const { rows } = await c.query(
            `insert into reservations(code,trip_id,travel_date,seat,from_city,to_city,depart,arrive,price,bus,box,client_id,ip)
             values('VH'||nextval('reservation_code_seq'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
            [trip.id, body.date, seat, trip.from, trip.to, trip.depart, trip.arrive, trip.price, trip.bus, trip.box || null, clientId, ip]);
          out.push(rows[0]);
        }
        return out;
      });
      return { reservations: created.map(resToJson) };
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Alguma poltrona acabou de ser ocupada. Escolha novamente.');
      throw e;
    }
  },

  'GET /reservations': async ({ query }) => {
    const clientId = str(query.clientId, 64, 'clientId');
    const { rows } = await db.query('select * from reservations where client_id=$1 order by id', [clientId]);
    return { reservations: rows.map(resToJson) };
  },

  'POST /driver-applications': async ({ req, body }) => {
    const name = str(body.name, 100, 'nome'), phone = str(body.phone, 30, 'telefone'), email = str(body.email, 120, 'e-mail');
    const city = str(body.city, 80, 'cidade'), cnh = oneOf(body.cnh, ['D', 'E'], 'CNH');
    const experience = oneOf(body.experience || 'Menos de 1 ano', ['Menos de 1 ano', '1 a 3 anos', '3 a 5 anos', 'Mais de 5 anos'], 'experiência');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('E-mail inválido.');
    const ip = auth.clientIp(req);
    const emailHash = enc.blindIndex(email);
    const dup = await db.query(`select 1 from driver_applications where email_hash=$1 and status<>'Recusado'`, [emailHash]);
    if (dup.rows.length) throw new HttpError(409, 'Já existe um cadastro com esse e-mail.');
    const pending = (await db.query(`select count(*)::int n from driver_applications where status='Pendente'`)).rows[0].n;
    if (pending >= 200) throw new HttpError(429, 'Limite de cadastros pendentes atingido. Tente mais tarde.');
    // telefone e e-mail vão criptografados; só o nome e a cidade ficam legíveis no banco
    await db.query('insert into driver_applications(name,phone,email,email_hash,city,cnh,experience) values($1,$2,$3,$4,$5,$6,$7)',
      [name, enc.encrypt(phone), enc.encrypt(email), emailHash, city, cnh, experience]);
    return { ok: true };
  },

  // ---------- login ----------
  'POST /login': async ({ req, res, body }) => {
    const role = oneOf(body.role, ['owner', 'driver'], 'perfil');
    const secret = str(body.secret, 200, 'senha');
    const ip = auth.clientIp(req);
    if (await auth.loginBlocked(ip)) throw new HttpError(429, 'Muitas tentativas. Aguarde 15 minutos.');
    if (role === 'owner') {
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw) throw new HttpError(503, 'Senha do administrador não configurada no servidor.');
      if (!auth.safeEqual(secret, pw)) await loginFailed(ip, 'Senha do administrador incorreta.');
      await auth.clearFailures(ip);
      auth.setSession(req, res, { r: 'owner' });
      return { role: 'owner' };
    }
    const { rows } = await db.query(`select id, name from driver_applications where status='Aprovado' and access_hash=$1`, [auth.hashDriverCode(secret)]);
    if (!rows.length) await loginFailed(ip, 'Código inválido ou cadastro ainda não aprovado.');
    await auth.clearFailures(ip);
    auth.setSession(req, res, { r: 'driver', d: rows[0].id });
    return { role: 'driver', id: rows[0].id, name: rows[0].name };
  },

  'POST /logout': async ({ req, res }) => { auth.clearSession(req, res); return { ok: true }; },

  // ---------- equipe (admin ou motorista) ----------
  'GET /staff/manifest': async ({ req, query }) => {
    await requireStaff(req);
    const trip = await T.resolveTrip(query.tripId);
    if (!trip || !T.validDate(query.date)) throw bad('Viagem ou data inválida.');
    const { rows } = await db.query('select seat, code from reservations where trip_id=$1 and travel_date=$2 order by seat', [trip.id, query.date]);
    return { passengers: rows.map(r => ({ seat: String(r.seat).padStart(2, '0'), code: r.code })) };
  },

  'GET /staff/trip-status': async ({ req }) => { await requireStaff(req); return { tripStatus: await kvGet('trip_status') }; },

  'POST /staff/trip-status': async ({ req, body }) => {
    await requireStaff(req);
    const trip = await T.resolveTrip(body.tripId);
    if (!trip) throw bad('Viagem inválida.');
    const status = oneOf(body.status, TRIP_STATUS, 'status');
    const cur = await kvGet('trip_status');
    cur[trip.id] = status;
    await kvSet('trip_status', cur);
    return { tripStatus: cur };
  },

  // ---------- motorista ----------
  'GET /driver/data': async ({ req }) => {
    const me = await requireDriver(req);
    const [trips, reqs] = await Promise.all([
      db.query(`select * from driver_trips where driver=$1 or (mode='Solicitação' and driver='') order by trip_date, hour`, [me.name]),
      db.query('select * from driver_requests where driver=$1 order by id', [me.name]),
    ]);
    return {
      me: { id: me.id, name: me.name },
      trips: trips.rows.map(driverTripJson),
      requests: reqs.rows.map(r => ({ id: r.id, tripId: r.trip_id, status: r.status })),
      tripStatus: await kvGet('trip_status'),
    };
  },

  'POST /driver/requests': async ({ req, body }) => {
    const me = await requireDriver(req);
    const tripId = intId(body.tripId, 'viagem');
    const t = (await db.query('select * from driver_trips where id=$1', [tripId])).rows[0];
    if (!t || t.mode !== 'Solicitação' || t.driver) throw new HttpError(409, 'Esta viagem não está mais aberta.');
    const dup = await db.query(`select 1 from driver_requests where trip_id=$1 and driver=$2 and status='Pendente'`, [tripId, me.name]);
    if (dup.rows.length) throw new HttpError(409, 'Você já solicitou esta viagem.');
    await db.query('insert into driver_requests(trip_id, driver) values($1,$2)', [tripId, me.name]);
    return { ok: true };
  },

  'POST /driver/respond': async ({ req, body }) => {
    const me = await requireDriver(req);
    const id = intId(body.id, 'escala');
    const r = await db.query(
      `update driver_trips set status=$1 where id=$2 and driver=$3 and mode='Escala' and status='Aguardando aceite' returning id`,
      [body.accept ? 'Aceita' : 'Recusada', id, me.name]);
    if (!r.rows.length) throw new HttpError(409, 'Escala indisponível para resposta.');
    return { ok: true };
  },

  // ---------- administrador ----------
  'GET /admin/data': async ({ req }) => {
    await requireOwner(req);
    const [apps, resv, names, dTrips, dReqs] = await Promise.all([
      db.query('select id,name,phone,email,city,cnh,experience,status,(access_hash is not null) as has_code, created_at from driver_applications order by id'),
      db.query('select * from reservations order by id'),
      db.query('select name from driver_names order by name'),
      db.query('select * from driver_trips order by trip_date, hour, id'),
      db.query('select r.*, t.from_city, t.to_city, t.trip_date, t.hour from driver_requests r join driver_trips t on t.id=r.trip_id order by r.id'),
    ]);
    return {
      apps: apps.rows.map(a => ({
        id: a.id, name: a.name, phone: enc.decrypt(a.phone), email: enc.decrypt(a.email), city: a.city, cnh: a.cnh, experience: a.experience,
        status: a.status, hasCode: a.has_code, createdAt: new Date(a.created_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      })),
      reservations: resv.rows.map(resToJson),
      driverNames: names.rows.map(n => n.name),
      driverTrips: dTrips.rows.map(driverTripJson),
      driverRequests: dReqs.rows.map(r => ({ id: r.id, tripId: r.trip_id, driver: r.driver, status: r.status, from: r.from_city, to: r.to_city, date: r.trip_date, hour: r.hour })),
      tripStatus: await kvGet('trip_status'),
      fleetStatus: await kvGet('fleet_status'),
    };
  },

  'POST /admin/driver-applications/review': async ({ req, body }) => {
    await requireOwner(req);
    const id = intId(body.id);
    const action = oneOf(body.action, ['approve', 'reject'], 'ação');
    if (action === 'reject') {
      await db.query(`update driver_applications set status='Recusado', access_hash=null where id=$1`, [id]);
      return { ok: true };
    }
    // gera um código único; só o hash é guardado e o código é devolvido apenas desta vez
    for (let i = 0; i < 5; i++) {
      const code = auth.newDriverCode();
      try {
        const r = await db.query(`update driver_applications set status='Aprovado', access_hash=$1 where id=$2 returning name`, [auth.hashDriverCode(code), id]);
        if (!r.rows.length) throw new HttpError(404, 'Cadastro não encontrado.');
        return { ok: true, code, name: r.rows[0].name };
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    throw new HttpError(500, 'Não foi possível gerar um código único. Tente de novo.');
  },

  'POST /admin/driver-names': async ({ req, body }) => {
    await requireOwner(req);
    const name = str(body.name, 100, 'nome do motorista');
    const dup = await db.query('select 1 from driver_names where lower(name)=lower($1) union select 1 from driver_applications where lower(name)=lower($1) and status=$2', [name, 'Aprovado']);
    if (dup.rows.length) throw new HttpError(409, 'Esse motorista já está cadastrado.');
    await db.query('insert into driver_names(name) values($1)', [name]);
    return { ok: true };
  },

  'POST /admin/driver-trips': async ({ req, body }) => {
    await requireOwner(req);
    const from = str(body.from, 80, 'origem'), to = str(body.to, 80, 'destino');
    if (from.toLowerCase() === to.toLowerCase()) throw bad('Origem e destino devem ser diferentes.');
    if (!T.validDate(body.date)) throw bad('Data inválida.');
    const hour = str(body.hour, 5, 'horário');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hour)) throw bad('Horário inválido.');
    const mode = oneOf(body.mode, ['Escala', 'Solicitação'], 'tipo');
    const driver = mode === 'Escala' ? str(body.driver, 100, 'motorista') : '';
    await db.query('insert into driver_trips(from_city,to_city,trip_date,hour,mode,driver,status) values($1,$2,$3,$4,$5,$6,$7)',
      [from, to, body.date, hour, mode, driver, mode === 'Escala' ? 'Aguardando aceite' : 'Disponível']);
    return { ok: true };
  },

  'POST /admin/driver-trips/status': async ({ req, body }) => {
    await requireOwner(req);
    const r = await db.query(`update driver_trips set status=$1 where id=$2 and mode='Escala' and status='Aguardando aceite' returning id`,
      [oneOf(body.status, ['Aceita', 'Recusada'], 'status'), intId(body.id)]);
    if (!r.rows.length) throw new HttpError(409, 'Escala indisponível para atualização.');
    return { ok: true };
  },

  'POST /admin/driver-requests/review': async ({ req, body }) => {
    await requireOwner(req);
    const id = intId(body.id);
    await db.tx(async c => {
      const r = (await c.query(`select * from driver_requests where id=$1 for update`, [id])).rows[0];
      if (!r || r.status !== 'Pendente') throw new HttpError(409, 'Solicitação já analisada.');
      if (!body.approve) { await c.query(`update driver_requests set status='Rejeitada' where id=$1`, [id]); return; }
      const t = (await c.query('select * from driver_trips where id=$1 for update', [r.trip_id])).rows[0];
      if (!t || t.driver) throw new HttpError(409, 'Essa viagem já tem motorista atribuído.');
      await c.query(`update driver_requests set status='Aprovada' where id=$1`, [id]);
      await c.query(`update driver_trips set driver=$1, status='Atribuída' where id=$2`, [r.driver, r.trip_id]);
      await c.query(`update driver_requests set status='Rejeitada' where trip_id=$1 and id<>$2 and status='Pendente'`, [r.trip_id, id]);
    });
    return { ok: true };
  },

  'POST /admin/fleet-status': async ({ req, body }) => {
    await requireOwner(req);
    const id = oneOf(body.id, FLEET_IDS, 'veículo'), status = oneOf(body.status, FLEET_STATUS, 'status');
    const cur = await kvGet('fleet_status');
    cur[id] = status;
    await kvSet('fleet_status', cur);
    return { fleetStatus: cur };
  },
};

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    // vercel.json reescreve /api/* para /api/index?__p=<caminho>; sem o parâmetro, usa o próprio pathname
    const rewritten = url.searchParams.get('__p');
    url.searchParams.delete('__p');
    const path = rewritten !== null
      ? '/' + rewritten.replace(/^\/+|\/+$/g, '')
      : url.pathname.replace(/^\/api(\/index)?/, '').replace(/\/+$/, '') || '/';
    const route = routes[req.method + ' ' + path];
    if (!route) {
      const exists = Object.keys(routes).some(k => k.endsWith(' ' + path));
      return send(res, exists ? 405 : 404, { error: exists ? 'Método não permitido.' : 'Rota não encontrada.' });
    }
    let body = {};
    if (req.method === 'POST') {
      // exige JSON: formulários de outros sites não conseguem enviar esse Content-Type sem preflight (proteção CSRF)
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return send(res, 415, { error: 'Content-Type deve ser application/json.' });
      }
      body = req.body && typeof req.body === 'object' ? req.body : {};
    }
    const query = Object.fromEntries(url.searchParams);
    return send(res, 200, await route({ req, res, body, query }));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e.code === 'NO_DB' || e.code === 'NO_SECRET') return send(res, 503, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Erro interno. Tente novamente.' });
  }
};
