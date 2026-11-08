import assert from 'node:assert/strict';
import test from 'node:test';
import { deltaRecordsKey, deltaServerUrl, fetchDeltaRecords } from './deltaRecords';

test('delta server address comes from the API address unless overridden', () => {
  assert.equal(deltaServerUrl({ OPEN_BALENA_API_URL: 'https://api.example.test' }), 'https://delta.example.test');
  assert.equal(
    deltaServerUrl({ OPEN_BALENA_API_URL: 'https://api.example.test', VECTOR_DELTA_URL: 'http://localhost:9/' }),
    'http://localhost:9',
  );
  assert.throws(() => deltaServerUrl({}));
});

test('the records key is a stable HMAC of the secret', () => {
  assert.equal(deltaRecordsKey('s3cret'), deltaRecordsKey('s3cret'));
  assert.notEqual(deltaRecordsKey('s3cret'), deltaRecordsKey('other'));
  assert.match(deltaRecordsKey('s3cret'), /^[0-9a-f]{64}$/);
});

test('records are fetched with the derived key and an unreachable server is reported plainly', async () => {
  const original = globalThis.fetch;
  try {
    let seen = '';
    globalThis.fetch = async (input, init) => {
      seen = `${String(input)} ${new Headers(init?.headers).get('x-delta-records-key')}`;
      return Response.json({ records: [{ id: 'a' }] });
    };
    const env = { OPEN_BALENA_JWT_SECRET: 'k', OPEN_BALENA_API_URL: 'https://api.example.test' };
    assert.equal((await fetchDeltaRecords(env)).length, 1);
    assert.equal(seen, `https://delta.example.test/api/records ${deltaRecordsKey('k')}`);
    globalThis.fetch = async () => {
      throw new Error('down');
    };
    await assert.rejects(fetchDeltaRecords(env), /not reachable/);
  } finally {
    globalThis.fetch = original;
  }
});
