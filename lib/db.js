const { Pool, types } = require('pg');

// date -> 'YYYY-MM-DD' (sem fuso), numeric -> number
types.setTypeParser(1082, v => v);
types.setTypeParser(1700, v => parseFloat(v));
types.setTypeParser(20, v => parseInt(v, 10));

let pool;
let ready;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) {
      const e = new Error('Banco de dados não configurado (DATABASE_URL ausente).');
      e.code = 'NO_DB';
      throw e;
    }
    const local = /(localhost|127\.0\.0\.1)/.test(url);
    pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10000,
      ssl: local ? false : (/sslmode=/.test(url) ? undefined : true),
    });
    pool.on('error', () => {});
  }
  return pool;
}

const SCHEMA = `
create table if not exists trips(
  id int primary key, from_city text not null, to_city text not null, depart text not null, arrive text not null,
  duration text not null, price numeric(10,2) not null, bus text not null, seats int not null default 46,
  available_seed int not null, box text, driver text, sort_order int not null default 0);
create sequence if not exists reservation_code_seq start 1001;
create table if not exists reservations(
  id bigserial primary key, code text unique not null, trip_id text not null, travel_date date not null, seat int not null,
  from_city text, to_city text, depart text, arrive text, price numeric(10,2), bus text, box text,
  client_id text not null, ip text, status text not null default 'PRÉ-RESERVA DEMO', created_at timestamptz not null default now(),
  unique(trip_id, travel_date, seat));
create index if not exists reservations_client_idx on reservations(client_id);
create table if not exists driver_applications(
  id bigserial primary key, name text not null, phone text not null, email text not null, city text not null,
  cnh text not null, experience text, status text not null default 'Pendente', access_hash text unique,
  created_at timestamptz not null default now());
create table if not exists driver_names(name text primary key);
create table if not exists driver_trips(
  id bigserial primary key, from_city text not null, to_city text not null, trip_date date not null, hour text not null,
  mode text not null, driver text not null default '', status text not null, created_at timestamptz not null default now());
create table if not exists driver_requests(
  id bigserial primary key, trip_id bigint not null references driver_trips(id) on delete cascade, driver text not null,
  status text not null default 'Pendente', created_at timestamptz not null default now());
create table if not exists kv(key text primary key, value jsonb not null);
create table if not exists login_attempts(ip text not null, at timestamptz not null default now());
create index if not exists login_attempts_ip_idx on login_attempts(ip, at);
`;

// [id, from, to, depart, arrive, duration, price, bus, seats, available, box, driver, order]
const SEED_TRIPS = [
  [6, 'Porto Alegre', 'Santana do Livramento', '07:30', '13:45', '6h 15min', 149.90, 'Executivo · VH-406', 46, 32, 'BOX 01', null, 1],
  [1, 'Porto Alegre', 'Santa Maria', '08:00', '11:45', '3h 45min', 89.90, 'Executivo', 46, 17, 'BOX 02', null, 2],
  [2, 'Porto Alegre', 'Passo Fundo', '09:30', '13:40', '4h 10min', 109.90, 'Leito', 46, 12, 'BOX 03', null, 3],
  [3, 'Santa Maria', 'Porto Alegre', '14:00', '17:45', '3h 45min', 89.90, 'Executivo', 46, 21, 'BOX 04', null, 4],
  [4, 'Caxias do Sul', 'Porto Alegre', '16:15', '18:45', '2h 30min', 74.90, 'Convencional', 46, 25, 'BOX 05', null, 5],
  [5, 'Porto Alegre', 'Caxias do Sul', '07:15', '09:45', '2h 30min', 74.90, 'Convencional', 46, 28, 'BOX 06', null, 6],
  [7, 'Bom Progresso', 'Montenegro', '06:30', '10:15', '3h 45min', 79.90, 'Executivo · VH-407', 46, 32, 'BOX 02', null, 7],
  [8, 'Montenegro', 'Bom Progresso', '14:30', '18:15', '3h 45min', 79.90, 'Executivo · VH-407', 46, 30, null, null, 8],
  [9, 'Porto Alegre', 'Santa Maria', '20:00', '23:45', '3h 45min', 94.90, 'Marcopolo Paradiso G6 · 6106', 46, 40, 'BOX 07', 'Carlos Eduardo Silva (DEMO)', 9],
  [10, 'Porto Alegre', 'Passo Fundo', '21:30', '01:40', '4h 10min', 114.90, 'Marcopolo Paradiso G7 · 7107', 46, 38, 'BOX 08', 'Marcos Vinícius Pereira (DEMO)', 10],
  [11, 'Santa Maria', 'Porto Alegre', '23:45', '03:30', '3h 45min', 94.90, 'Marcopolo Paradiso G8 · 8108', 46, 42, 'BOX 09', 'André Luiz Martins (DEMO)', 11],
];
const SEED_DRIVER_NAMES = ['Carlos Martins (DEMO)', 'Ana Ribeiro (DEMO)', 'João Ferreira (DEMO)'];
const SEED_FLEET = { '6106': 'Em viagem', '7107': 'Em viagem', '8108': 'Na oficina', 'VH-101': 'Disponível', 'VH-204': 'Na oficina', 'VH-305': 'Disponível', 'VH-406': 'Em viagem', 'VH-407': 'Disponível' };

async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query(SCHEMA);
    for (const t of SEED_TRIPS) {
      await client.query(
        `insert into trips(id,from_city,to_city,depart,arrive,duration,price,bus,seats,available_seed,box,driver,sort_order)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do nothing`, t);
    }
    for (const n of SEED_DRIVER_NAMES) await client.query('insert into driver_names(name) values($1) on conflict do nothing', [n]);
    await client.query(`insert into kv(key,value) values('fleet_status',$1) on conflict do nothing`, [JSON.stringify(SEED_FLEET)]);
    await client.query(`insert into kv(key,value) values('trip_status','{}') on conflict do nothing`);
  } finally {
    try { await client.query('select pg_advisory_unlock(727274)'); } catch (e) {}
    client.release();
  }
}

// Garante o schema uma vez por instância; em caso de falha tenta de novo na próxima requisição.
function ensureReady() {
  if (!ready) ready = migrate().catch(e => { ready = null; throw e; });
  return ready;
}

async function query(text, params) {
  await ensureReady();
  return getPool().query(text, params);
}

async function tx(fn) {
  await ensureReady();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, tx, ensureReady };
