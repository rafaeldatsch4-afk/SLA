// Servidor local de desenvolvimento: serve os arquivos estáticos e a API (/api) como a Vercel faria.
// Uso: DATABASE_URL=postgres://... SESSION_SECRET=... ADMIN_PASSWORD=... node dev-server.js [porta]
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('./api/index.js');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    // mesmo rewrite do vercel.json: /api/a/b?x=1 -> /api/index?__p=a/b&x=1
    const u = new URL(req.url, 'http://localhost');
    const sub = u.pathname.replace(/^\/api\/?/, '');
    u.searchParams.set('__p', sub);
    req.url = '/api/index' + u.search;
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch (e) { req.body = undefined; }
      handler(req, res);
    });
    return;
  }
  const file = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, path.normalize(file));
  if (!full.startsWith(__dirname) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
}).listen(Number(process.argv[2]) || 3000, () => console.log('http://localhost:' + (process.argv[2] || 3000)));
