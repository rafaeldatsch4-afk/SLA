const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'vh_session';
const SESSION_HOURS = 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    const e = new Error('SESSION_SECRET ausente ou curto.');
    e.code = 'NO_SECRET';
    throw e;
  }
  return s;
}

const b64 = buf => Buffer.from(buf).toString('base64url');
const hmac = data => crypto.createHmac('sha256', secret()).update(data).digest();

// compara em tempo constante, mesmo com tamanhos diferentes
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// hash de código de motorista com pepper (inviável de quebrar offline sem SESSION_SECRET)
function hashDriverCode(code) {
  return hmac('driver:' + code).toString('hex');
}

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return body + '.' + b64(hmac(body));
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64(hmac(body));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isSecure(req) {
  const proto = req.headers['x-forwarded-proto'];
  const host = String(req.headers.host || '');
  return proto === 'https' || !/^(localhost|127\.0\.0\.1)/.test(host);
}

function setSession(req, res, payload) {
  const token = sign({ ...payload, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${isSecure(req) ? '; Secure' : ''}`);
}

function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}

// Retorna { role:'owner' } | { role:'driver', id, name } | null. Motorista revogado perde a sessão na hora.
async function getSession(req) {
  const p = verify(parseCookies(req)[COOKIE]);
  if (!p) return null;
  if (p.r === 'owner') return { role: 'owner' };
  if (p.r === 'driver') {
    const { rows } = await db.query(`select id, name from driver_applications where id=$1 and status='Aprovado'`, [p.d]);
    if (!rows.length) return null;
    return { role: 'driver', id: rows[0].id, name: rows[0].name };
  }
  return null;
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 8 falhas em 15 min por IP => bloqueia
async function loginBlocked(ip) {
  const { rows } = await db.query(`select count(*)::int as n from login_attempts where ip=$1 and at > now() - interval '15 minutes'`, [ip]);
  return rows[0].n >= LOGIN_MAX;
}
const LOGIN_MAX = 8;
async function failuresLeft(ip) {
  const { rows } = await db.query(`select count(*)::int as n from login_attempts where ip=$1 and at > now() - interval '15 minutes'`, [ip]);
  return Math.max(0, LOGIN_MAX - rows[0].n);
}
async function registerFailure(ip) {
  await db.query('insert into login_attempts(ip) values($1)', [ip]);
  await db.query(`delete from login_attempts where at < now() - interval '1 day'`); // tabela não cresce para sempre
}
const clearFailures = ip => db.query('delete from login_attempts where ip=$1', [ip]);

function newDriverCode() {
  return String(10000000 + crypto.randomInt(0, 90000000)); // 8 dígitos
}

module.exports = {
  safeEqual, hashDriverCode, setSession, clearSession, getSession, clientIp,
  loginBlocked, failuresLeft, registerFailure, clearFailures, newDriverCode,
};
