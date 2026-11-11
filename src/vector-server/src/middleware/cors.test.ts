import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createCors, parseAllowedOrigins } from './cors';

test('allowed origins must be bare http(s) origins', () => {
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(' https://a.example.com/ , https://a.example.com, http://localhost:3000 '), [
    'https://a.example.com',
    'http://localhost:3000',
  ]);
  assert.throws(() => parseAllowedOrigins('https://a.example.com/path'), /bare http\(s\) origins/);
  assert.throws(() => parseAllowedOrigins('ftp://a.example.com'), /bare http\(s\) origins/);
  assert.throws(() => parseAllowedOrigins('not a url'), /invalid origin/);
});

test('only listed origins receive CORS headers and preflights are answered', async () => {
  const app = express();
  app.use(createCors(['https://ui.example.com']));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const allowed = await fetch(`${base}/ping`, { headers: { Origin: 'https://ui.example.com' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://ui.example.com');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
    assert.match(allowed.headers.get('access-control-expose-headers') ?? '', /Content-Range/);

    const other = await fetch(`${base}/ping`, { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal(other.status, 200);

    const preflight = await fetch(`${base}/ping`, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://ui.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization,content-type');

    const noOrigin = await fetch(`${base}/ping`);
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
