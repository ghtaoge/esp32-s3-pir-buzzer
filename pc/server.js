'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/core.js', ['core.js', 'text/javascript; charset=utf-8']],
  ['/transports.js', ['transports.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/protocol.js', ['../miniprogram/utils/protocol.js', 'text/javascript; charset=utf-8']]
]);

function createServer() {
  return http.createServer((request, response) => {
    let requestUrl;
    try { requestUrl = new URL(request.url, 'http://127.0.0.1'); } catch (_) { response.writeHead(400).end(); return; }
    const host = (request.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { response.writeHead(403).end('Local access only'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (requestUrl.pathname === '/favicon.ico') { response.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return; }
    const route = routes.get(requestUrl.pathname);
    if (!route) { response.writeHead(404).end('Not found'); return; }
    fs.readFile(path.resolve(__dirname, route[0]), (error, data) => {
      if (error) { response.writeHead(503).end('Application asset unavailable'); return; }
      response.writeHead(200, {
        'Content-Type': route[1], 'Content-Length': data.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'Permissions-Policy': 'serial=(self), bluetooth=(self)'
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    });
  });
}

if (require.main === module) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('Invalid port'); process.exitCode = 1; }
  else {
    const server = createServer();
    server.on('error', error => { console.error('Cannot start local console:', error.message); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Sentinel console: http://127.0.0.1:${port}`));
  }
}
module.exports = { createServer };
