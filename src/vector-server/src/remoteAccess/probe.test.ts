import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { DeviceProber } from './probe';

const identity = { userId: 1, username: 'admin', token: 'a.b.c' };
const uuid = 'a'.repeat(32);

test('reports a reachable device with its latency and closes the tunnel', async () => {
  let clock = 1000;
  const socket = new PassThrough();
  const prober = new DeviceProber(
    async () => {
      clock += 40;
      return socket;
    },
    async () => undefined,
    1000,
    () => clock,
  );
  const result = await prober.probe(identity, uuid);
  assert.equal(result.reachable, true);
  assert.equal(result.latencyMs, 40);
  assert.equal(socket.destroyed, true);
});

test('explains an unreachable device instead of failing', async () => {
  const prober = new DeviceProber(
    async () => {
      throw new Error('Tunnel refused the connection (503).');
    },
    async () => undefined,
    1000,
  );
  const result = await prober.probe(identity, uuid);
  assert.equal(result.reachable, false);
  assert.match(result.reason ?? '', /no working tunnel/);
});

test('shares one probe between viewers and caches authorization', async () => {
  let opens = 0;
  let authorizations = 0;
  let clock = 0;
  const prober = new DeviceProber(
    async () => {
      opens += 1;
      return new PassThrough();
    },
    async () => {
      authorizations += 1;
    },
    1000,
    () => clock,
  );
  await prober.probe(identity, uuid);
  await prober.probe(identity, uuid);
  assert.equal(opens, 1);
  assert.equal(authorizations, 1);
  clock += 6000;
  await prober.probe(identity, uuid);
  assert.equal(opens, 2);
  assert.equal(authorizations, 1);
});

test('refuses users without access to the device', async () => {
  const prober = new DeviceProber(
    async () => new PassThrough(),
    async () => {
      throw new Error('Device access denied.');
    },
    1000,
  );
  await assert.rejects(prober.probe(identity, uuid), /access denied/);
});
