const db = require('./db');

const CITY_RE = /^[\p{L}0-9 .'’\-]{2,60}$/u;
const SIM_DEPARTS = ['06:30', '12:00', '20:00'];
const SIM_AVAILABLE = [39, 34, 42];

const normCity = x => String(x).toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const pad2 = n => String(n).padStart(2, '0');
const validCity = c => typeof c === 'string' && CITY_RE.test(c.trim());
const validDate = d => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const x = new Date(d + 'T00:00:00Z');
  return !isNaN(x) && x.toISOString().slice(0, 10) === d;
};
const todayBR = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const nowHourBR = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const HORIZON_DAYS = 180;
// data entre hoje e hoje+180 dias (evita reservas absurdas como o ano 2999)
const withinHorizon = d => {
  const limit = new Date(todayBR() + 'T00:00:00Z');
  limit.setUTCDate(limit.getUTCDate() + HORIZON_DAYS);
  return d >= todayBR() && d <= limit.toISOString().slice(0, 10);
};
// viagem de hoje cujo horário de saída já passou (horário de Brasília)
const isDeparted = (trip, date) => date === todayBR() && trip.depart <= nowHourBR();

function minutesToClock(total) {
  total = ((total % 1440) + 1440) % 1440;
  return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
}

function estimateDuration(from, to) {
  const a = normCity(from), b = normCity(to);
  const known = {
    'porto alegre|caxias do sul': 150, 'porto alegre|gramado': 135, 'porto alegre|canela': 150, 'porto alegre|bento goncalves': 165,
    'porto alegre|passo fundo': 250, 'porto alegre|santa maria': 225, 'porto alegre|pelotas': 210, 'porto alegre|florianopolis': 330,
    'porto alegre|curitiba': 420, 'porto alegre|santana do livramento': 375, 'bom progresso|montenegro': 260, 'montenegro|bom progresso': 260,
    'caxias do sul|gramado': 105, 'caxias do sul|canela': 120, 'caxias do sul|bento goncalves': 75, 'gramado|canela': 35,
  };
  let n = known[a + '|' + b] || known[b + '|' + a];
  if (!n) {
    const longNames = ['florianopolis', 'curitiba', 'sao paulo', 'rio de janeiro', 'belo horizonte', 'brasilia', 'campo grande', 'goiania', 'vitoria', 'salvador', 'recife', 'fortaleza', 'belem', 'manaus', 'porto velho', 'rio branco', 'macapa', 'boa vista', 'palmas', 'maceio', 'aracaju', 'joao pessoa', 'natal', 'teresina', 'sao luis'];
    n = (longNames.includes(a) || longNames.includes(b)) ? 480 : 225;
    if (a.includes('porto alegre') || b.includes('porto alegre')) n = Math.max(n, 180);
  }
  return n;
}

const hashStr = s => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 2147483647; return h + 1; };

// assentos "já vendidos" da demonstração, determinísticos por viagem
function baseTaken(trip) {
  const total = trip.seats || 46;
  const need = Math.max(0, Math.min(total, total - (trip.available_seed || 0)));
  const taken = [];
  let x = hashStr(trip.id);
  while (taken.length < need) {
    x = (x * 48271) % 2147483647;
    const n = x % total + 1;
    if (!taken.includes(n)) taken.push(n);
  }
  return taken;
}

function rowToTrip(r) {
  return {
    id: String(r.id), from: r.from_city, to: r.to_city, depart: r.depart, arrive: r.arrive, duration: r.duration,
    price: r.price, bus: r.bus, seats: r.seats, available_seed: r.available_seed, box: r.box || undefined,
    driver: r.driver || undefined, simulated: r.simulated || undefined,
  };
}

function simTrip(from, to, depart) {
  const i = SIM_DEPARTS.indexOf(depart);
  const duration = estimateDuration(from, to);
  const [hh, mm] = depart.split(':').map(Number);
  return {
    id: 'sim|' + encodeURIComponent(from) + '|' + encodeURIComponent(to) + '|' + depart,
    from, to, depart, arrive: minutesToClock(hh * 60 + mm + duration),
    duration: Math.floor(duration / 60) + 'h ' + pad2(duration % 60) + 'min',
    price: Math.round((49.9 + duration * 0.34) * 100) / 100,
    bus: 'Ônibus a confirmar', seats: 46, available_seed: SIM_AVAILABLE[i], simulated: true,
  };
}

// id numérico => viagem cadastrada; "sim|origem|destino|hora" => horário ilustrativo recalculado no servidor
async function resolveTrip(id) {
  id = String(id || '');
  if (/^\d{1,9}$/.test(id)) {
    const { rows } = await db.query('select * from trips where id=$1', [Number(id)]);
    return rows.length ? rowToTrip(rows[0]) : null;
  }
  const m = id.match(/^sim\|([^|]+)\|([^|]+)\|(\d\d:\d\d)$/);
  if (!m) return null;
  let from, to;
  try { from = decodeURIComponent(m[1]); to = decodeURIComponent(m[2]); } catch (e) { return null; }
  if (!validCity(from) || !validCity(to) || !SIM_DEPARTS.includes(m[3]) || normCity(from) === normCity(to)) return null;
  return simTrip(from.trim(), to.trim(), m[3]);
}

// Preenche `available` para a data informada, em uma consulta só
async function withAvailability(trips, date) {
  if (!trips.length) return trips;
  const { rows } = await db.query(
    'select trip_id, array_agg(seat) as seats from reservations where travel_date=$1 and trip_id = any($2) group by trip_id',
    [date, trips.map(t => t.id)]);
  const sold = Object.fromEntries(rows.map(r => [r.trip_id, r.seats]));
  return trips.map(t => {
    const taken = new Set([...baseTaken(t), ...(sold[t.id] || [])]);
    const { available_seed, ...rest } = t;
    return { ...rest, date, departed: isDeparted(t, date), available: Math.max(0, t.seats - taken.size) };
  });
}

async function takenSeats(trip, date) {
  const { rows } = await db.query('select seat from reservations where trip_id=$1 and travel_date=$2', [trip.id, date]);
  return [...new Set([...baseTaken(trip), ...rows.map(r => r.seat)])].sort((a, b) => a - b);
}

async function searchTrips(from, to, date) {
  // poucas linhas cadastradas: filtra em memória, ignorando acentos e maiúsculas
  const all = await db.query('select * from trips order by sort_order');
  const f = normCity(from), t = normCity(to);
  let list = all.rows.filter(r => normCity(r.from_city) === f && normCity(r.to_city) === t).map(rowToTrip);
  if (!list.length) list = SIM_DEPARTS.map(d => simTrip(from.trim(), to.trim(), d));
  list = await withAvailability(list, date);
  return list.filter(t => t.available > 0 && !t.departed).sort((a, b) => a.depart.localeCompare(b.depart));
}

module.exports = {
  withinHorizon, isDeparted, CITY_RE, normCity, validCity, validDate, todayBR, baseTaken, rowToTrip, resolveTrip, withAvailability, takenSeats, searchTrips, pad2,
};
