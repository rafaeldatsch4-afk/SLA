const crypto = require('crypto');

// Criptografia de campos pessoais (AES-256-GCM) com chave derivada de DATA_ENCRYPTION_KEY.
// Formato guardado: v1:<iv>.<tag>.<texto cifrado> (base64url). O prefixo "v1" permite trocar o esquema no futuro.
const PREFIX = 'v1:';

function keys() {
  const k = process.env.DATA_ENCRYPTION_KEY;
  if (!k || k.length < 32) {
    const e = new Error('DATA_ENCRYPTION_KEY ausente ou curta (mínimo 32 caracteres).');
    e.code = 'NO_SECRET';
    throw e;
  }
  const derive = info => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(k), Buffer.from('vh-salt-v1'), info, 32));
  return { enc: derive('encrypt'), index: derive('blind-index') };
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map(b => b.toString('base64url')).join('.');
}

// valores antigos (sem prefixo) são devolvidos como estão e criptografados na próxima migração
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split('.').map(p => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// Hash com chave (HMAC) do e-mail normalizado: permite achar duplicados sem guardar o e-mail em claro.
function blindIndex(value) {
  return crypto.createHmac('sha256', keys().index).update(String(value).trim().toLowerCase()).digest('hex');
}

module.exports = { encrypt, decrypt, blindIndex, PREFIX };
