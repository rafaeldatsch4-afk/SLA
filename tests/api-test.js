const BASE = process.env.BASE || 'http://localhost:3100';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
let cookie = '';
async function call(method, path, body, { cookieOverride, raw } = {}) {
  const headers = {};
  if (method === 'POST' && !raw) headers['Content-Type'] = 'application/json';
  const ck = cookieOverride !== undefined ? cookieOverride : cookie;
  if (ck) headers.Cookie = ck;
  const r = await fetch(BASE + path, { method, headers, body: method === 'POST' ? (raw ? body : JSON.stringify(body || {})) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc && cookieOverride === undefined) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j, sc };
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const cid = 'abcd1234-abcd-1234-abcd-1234567890ab';

(async () => {
  let r = await call('GET', '/api/health'); ok(r.status === 200 && r.j.ok, 'health / schema criado');
  r = await call('GET', '/api/trips?date=' + today); ok(r.j.trips.length === 11 && r.j.trips[0].id === '6', 'lista 11 viagens cadastradas');
  const t1 = r.j.trips.find(t => t.id === '1'); ok(t1.available === 17, 'vagas = 17 na viagem 1 (' + t1.available + ')');
  r = await call('GET', '/api/search?from=Porto%20Alegre&to=Santa%20Maria&date=' + today);
  ok(r.j.trips.length === 2, 'busca POA→Santa Maria acha 2 cadastradas');
  r = await call('GET', '/api/search?from=Porto%20Alegre&to=Manaus&date=' + today);
  ok(r.j.trips.length === 3 && r.j.trips[0].simulated && r.j.trips[0].id.startsWith('sim|'), 'rota simulada gera 3 horários');
  const sim = r.j.trips[0];
  r = await call('GET', '/api/search?from=%3Cscript%3E&to=Manaus&date=' + today); ok(r.status === 400, 'cidade com HTML rejeitada');
  r = await call('GET', '/api/search?from=A&to=B&date=2001-01-01'); ok(r.status === 400, 'data passada rejeitada');

  // reservas
  r = await call('GET', '/api/seats?trip=1&date=' + today); const taken = r.j.taken; ok(taken.length === 29, '29 ocupadas na viagem 1 (' + taken.length + ')');
  const free = []; for (let n = 1; n <= 46 && free.length < 3; n++) if (!taken.includes(n)) free.push(n);
  r = await call('POST', '/api/reservations', { tripId: '1', date: today, seats: [free[0], free[1]], clientId: cid });
  ok(r.status === 200 && r.j.reservations.length === 2 && /^VH\d+$/.test(r.j.reservations[0].code), 'reserva 2 poltronas: ' + (r.j.reservations || []).map(x => x.code));
  r = await call('POST', '/api/reservations', { tripId: '1', date: today, seats: [free[0]], clientId: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz' });
  ok(r.status === 409, 'mesma poltrona de novo => 409');
  r = await call('POST', '/api/reservations', { tripId: '1', date: today, seats: [taken[0]], clientId: cid }); ok(r.status === 409, 'poltrona da demo ocupada => 409');
  r = await call('POST', '/api/reservations', { tripId: '1', date: today, seats: [1, 2, 3, 4, 5], clientId: cid }); ok(r.status === 400, 'mais de 4 poltronas rejeitado');
  r = await call('GET', '/api/trips?date=' + today); ok(r.j.trips.find(t => t.id === '1').available === 15, 'vagas caem para 15');
  // corrida: 5 reservas simultâneas da mesma poltrona
  const s2 = (await call('GET', '/api/seats?trip=2&date=' + today)).j.taken; let freeSeat = 1; while (s2.includes(freeSeat)) freeSeat++;
  const racers = await Promise.all([1, 2, 3, 4, 5].map(i => call('POST', '/api/reservations', { tripId: '2', date: today, seats: [freeSeat], clientId: 'race000' + i + '-aaaa-bbbb-cccc-dddddddddddd' })));
  ok(racers.filter(x => x.status === 200).length === 1 && racers.filter(x => x.status === 200).length + racers.filter(x => x.status === 409).length === 5, 'corrida: no máx. 1 vence (' + racers.map(x => x.status) + ')');
  r = await call('POST', '/api/reservations', { tripId: sim.id, date: today, seats: [10], clientId: cid }); ok(r.status === 200 && r.j.reservations[0].tripId === sim.id, 'reserva em horário simulado');
  r = await call('POST', '/api/reservations', { tripId: 'sim|x|y|06:30', date: today, seats: [10], clientId: cid }); ok(r.status === 404, 'sim id forjado rejeitado');
  r = await call('GET', '/api/reservations?clientId=' + cid); ok(r.j.reservations.length === 3, 'minhas reservas = 3');
  r = await call('GET', '/api/reservations?clientId=outro-cliente-1234567'); ok(r.j.reservations.length === 0, 'reservas isoladas por cliente');

  // CSRF / método
  r = await call('POST', '/api/login', 'role=owner&secret=x', { raw: true }); ok(r.status === 415, 'POST sem JSON => 415');
  r = await call('GET', '/api/login'); ok(r.status === 405, 'GET em rota POST => 405');
  r = await call('GET', '/api/nada'); ok(r.status === 404, 'rota inexistente => 404');

  // permissões sem login
  for (const p of ['/api/admin/data', '/api/driver/data', '/api/staff/trip-status']) { r = await call('GET', p); ok(r.status === 401, 'sem login ' + p + ' => 401'); }
  r = await call('POST', '/api/admin/fleet-status', { id: 'VH-101', status: 'Em viagem' }); ok(r.status === 401, 'admin POST sem login => 401');
  r = await call('GET', '/api/me'); ok(r.j.role === null, 'me sem sessão');

  // candidatura
  r = await call('POST', '/api/driver-applications', { name: 'Joana Teste', phone: '5199', email: 'joana@t.com', city: 'Canela', cnh: 'D', experience: '1 a 3 anos' }); ok(r.status === 200, 'candidatura enviada');
  r = await call('POST', '/api/driver-applications', { name: 'Joana 2', phone: '5199', email: 'JOANA@t.com', city: 'Canela', cnh: 'D' }); ok(r.status === 409, 'e-mail duplicado => 409');
  r = await call('POST', '/api/driver-applications', { name: 'X', phone: '1', email: 'ruim', city: 'C', cnh: 'A' }); ok(r.status === 400, 'candidatura inválida => 400');

  // login admin
  r = await call('POST', '/api/login', { role: 'owner', secret: 'errada' }); ok(r.status === 401, 'senha errada => 401');
  r = await call('POST', '/api/login', { role: 'owner', secret: process.env.ADMIN_PASSWORD });
  ok(r.status === 200 && /HttpOnly/.test(r.sc) && /SameSite=Lax/.test(r.sc), 'login admin com cookie HttpOnly');
  r = await call('GET', '/api/me'); ok(r.j.role === 'owner', 'me = owner');
  r = await call('GET', '/api/admin/data'); const d = r.j; const joana = d.apps.find(a => a.name === 'Joana Teste'); ok(r.status === 200 && !!joana && d.reservations.length >= 3, 'admin/data ok');
  ok(joana.email === 'joana@t.com' && joana.phone === '5199', 'admin vê telefone/e-mail descriptografados');
  ok(!JSON.stringify(d).includes('access_hash'), 'hash não vaza em admin/data');
  // cookie adulterado
  r = await call('GET', '/api/admin/data', null, { cookieOverride: cookie.slice(0, -3) + 'abc' }); ok(r.status === 401, 'cookie adulterado => 401');

  // aprovar motorista
  r = await call('POST', '/api/admin/driver-applications/review', { id: joana.id, action: 'approve' }); const code = r.j.code; ok(/^\d{8}$/.test(code), 'aprovação devolve código de 8 dígitos');
  r = await call('GET', '/api/admin/data'); ok(r.j.apps.find(a => a.id === joana.id).hasCode && r.j.apps.find(a => a.id === joana.id).status === 'Aprovado' && !JSON.stringify(r.j).includes(code), 'código não aparece de novo');
  // viagem aberta + escala
  await call('POST', '/api/admin/driver-trips', { from: 'Canela', to: 'Gramado', date: today, hour: '08:00', mode: 'Solicitação' });
  await call('POST', '/api/admin/driver-trips', { from: 'Gramado', to: 'Canela', date: today, hour: '09:00', mode: 'Escala', driver: 'Joana Teste' });
  r = await call('POST', '/api/admin/driver-trips', { from: 'A', to: 'a', date: today, hour: '08:00', mode: 'Escala', driver: 'x' }); ok(r.status === 400, 'origem=destino rejeitado');
  r = await call('POST', '/api/admin/fleet-status', { id: 'VH-101', status: 'Em viagem' }); ok(r.status === 200 && r.j.fleetStatus['VH-101'] === 'Em viagem', 'status da frota gravado');
  r = await call('POST', '/api/admin/fleet-status', { id: 'XXX', status: 'Em viagem' }); ok(r.status === 400, 'veículo inválido rejeitado');
  r = await call('POST', '/api/staff/trip-status', { tripId: '1', status: 'Em andamento' }); ok(r.status === 200, 'status de viagem gravado');
  r = await call('GET', '/api/staff/manifest?tripId=1&date=' + today); ok(r.j.passengers.length === 2, 'manifesto lista 2 passageiros');
  const ownerCookie = cookie;

  // motorista
  await call('POST', '/api/logout'); r = await call('GET', '/api/me'); ok(r.j.role === null, 'logout limpa sessão');
  r = await call('POST', '/api/login', { role: 'driver', secret: '00000000' }); ok(r.status === 401, 'código errado => 401');
  r = await call('POST', '/api/login', { role: 'driver', secret: code }); ok(r.status === 200 && r.j.name === 'Joana Teste', 'login motorista');
  r = await call('GET', '/api/admin/data'); ok(r.status === 401, 'motorista não acessa admin');
  r = await call('GET', '/api/driver/data'); const dd = r.j; ok(dd.trips.length === 2, 'motorista vê 1 escala + 1 aberta');
  const open = dd.trips.find(t => t.mode === 'Solicitação'), scale = dd.trips.find(t => t.mode === 'Escala');
  r = await call('POST', '/api/driver/respond', { id: scale.id, accept: true }); ok(r.status === 200, 'motorista aceita escala');
  r = await call('POST', '/api/driver/respond', { id: scale.id, accept: false }); ok(r.status === 409, 'não responde duas vezes');
  r = await call('POST', '/api/driver/requests', { tripId: open.id }); ok(r.status === 200, 'solicita viagem aberta');
  r = await call('POST', '/api/driver/requests', { tripId: open.id }); ok(r.status === 409, 'solicitação duplicada => 409');
  const driverCookie = cookie;

  // dono aprova
  cookie = ownerCookie; r = await call('GET', '/api/admin/data'); const rq = r.j.driverRequests[0];
  r = await call('POST', '/api/admin/driver-requests/review', { id: rq.id, approve: true }); ok(r.status === 200, 'dono aprova solicitação');
  r = await call('GET', '/api/admin/data'); ok(r.j.driverTrips.find(t => t.id === open.id).status === 'Atribuída' && r.j.driverTrips.find(t => t.id === open.id).driver === 'Joana Teste', 'viagem atribuída');
  r = await call('POST', '/api/admin/driver-requests/review', { id: rq.id, approve: true }); ok(r.status === 409, 'não analisa de novo');

  // revogar => sessão do motorista morre
  r = await call('POST', '/api/admin/driver-applications/review', { id: joana.id, action: 'reject' }); ok(r.status === 200, 'dono revoga acesso');
  cookie = driverCookie; r = await call('GET', '/api/driver/data'); ok(r.status === 401, 'sessão do motorista revogado cai na hora');

  // rate limit de login
  cookie = '';
  let last; for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { role: 'owner', secret: 'x' + i });
  ok(last.status === 429, 'bloqueio após várias falhas => 429');
  r = await call('POST', '/api/login', { role: 'owner', secret: process.env.ADMIN_PASSWORD }); ok(r.status === 429, 'mesmo a senha certa fica bloqueada durante o bloqueio');

  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
