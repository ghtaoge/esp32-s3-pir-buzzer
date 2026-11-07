'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server');

test('local static server serves only explicit assets and rejects foreign hosts/mutations', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const asset of ['/', '/styles.css', '/core.js', '/transports.js', '/app.js', '/protocol.js']) {
      const result = await fetch(base + asset);
      assert.equal(result.status, 200, asset);
      assert.ok(result.headers.get('content-security-policy').includes("object-src 'none'"));
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((await result.text()).length > 10);
    }
    for (const asset of ['/README.md', '/package.json', '/../README.md', '/%2e%2e%2fREADME.md', '/.git/config']) assert.equal((await fetch(base + asset)).status, 404, asset);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(base + '/', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(base + '/favicon.ico')).status, 204);
    const head = await fetch(base + '/', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
