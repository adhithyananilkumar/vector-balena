import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { crc32 } from 'node:zlib';
import {
  BaseImageConflictError,
  BaseImageStore,
  BaseImageValidationError,
  assertBaseImageId,
  assertDeviceType,
  assertVersion,
  baseImageId,
  type BaseImage,
} from './baseImages';
import { clearCatalogCache, listOsVersions } from './catalog';

/** A minimal single-file ZIP using the "stored" method, enough for the extractor. */
const buildStoredZip = (name: string, data: Buffer): Buffer => {
  const nameBuffer = Buffer.from(name);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(12 * 32 + 1, 12 - 0); // dos date (any valid value)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const localPart = Buffer.concat([local, nameBuffer, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(12 * 32 + 1, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  const centralPart = Buffer.concat([central, nameBuffer]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
};

const waitFor = async <T>(read: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

interface Fixture {
  store: BaseImageStore;
  dir: string;
  hits: () => number;
}

const fixture = async (
  t: TestContext,
  options: { archive?: Buffer; status?: number; delayMs?: number; maxConcurrent?: number } = {},
): Promise<Fixture> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vector-base-images-'));
  let hits = 0;
  const archive = options.archive ?? buildStoredZip('generic-amd64-9.0.4.img', Buffer.from('FAKE-DISK-IMAGE-BYTES'));
  const server: Server = createServer((req, res) => {
    hits += 1;
    setTimeout(() => {
      if (options.status && options.status !== 200) {
        res.writeHead(options.status).end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length });
      res.end(archive);
    }, options.delayMs ?? 0);
    void req;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const store = new BaseImageStore({
    dir,
    downloadUrl: (deviceType, version) =>
      `http://127.0.0.1:${address.port}/download?deviceType=${deviceType}&version=${encodeURIComponent(version)}`,
    maxConcurrent: options.maxConcurrent,
  });
  return { store, dir, hits: () => hits };
};

const settled = (store: BaseImageStore, id: string) =>
  waitFor(async () => {
    const image = (await store.list()).find((candidate) => candidate.id === id);
    return image && (image.state === 'ready' || image.state === 'error') ? image : undefined;
  });

test('inputs are strictly validated so nothing can escape the images folder', () => {
  assert.equal(assertDeviceType('generic-amd64'), 'generic-amd64');
  assert.equal(assertVersion('9.0.4+rev1'), '9.0.4+rev1');
  assert.equal(baseImageId('generic-amd64', '9.0.4+rev1'), 'generic-amd64--9.0.4_plus_rev1');
  assert.equal(assertBaseImageId('generic-amd64--9.0.4_plus_rev1'), 'generic-amd64--9.0.4_plus_rev1');

  for (const bad of ['../etc', 'a/b', 'A-B', '', ' x', 'x;rm', 'x'.repeat(80)]) {
    assert.throws(() => assertDeviceType(bad), BaseImageValidationError, `device type ${JSON.stringify(bad)}`);
  }
  for (const bad of ['../1', '9.0.4; rm -rf', '', '9 0', 'v/1']) {
    assert.throws(() => assertVersion(bad), BaseImageValidationError, `version ${JSON.stringify(bad)}`);
  }
  for (const bad of ['..', '../x', 'x--y/z', 'nodoubledash', '']) {
    assert.throws(() => assertBaseImageId(bad), BaseImageValidationError, `id ${JSON.stringify(bad)}`);
  }
});

test('downloads once, extracts the disk image, and finds it again instead of downloading twice', async (t) => {
  const { store, dir, hits } = await fixture(t);

  assert.equal(await store.resolveReady('generic-amd64', '9.0.4'), undefined, 'nothing downloaded yet');

  const started = await store.start('generic-amd64', '9.0.4');
  assert.equal(started.state, 'downloading');

  const ready = await settled(store, started.id);
  assert.equal(ready.state, 'ready', ready.error);
  assert.equal(ready.sizeBytes, 'FAKE-DISK-IMAGE-BYTES'.length);

  const imagePath = await store.resolveReady('generic-amd64', '9.0.4');
  assert.ok(imagePath, 'the ready image is found on disk');
  assert.equal(await readFile(imagePath, 'utf8'), 'FAKE-DISK-IMAGE-BYTES');
  assert.deepEqual((await readdir(path.join(dir, started.id))).sort(), ['balena.img', 'meta.json'], 'archive was removed');

  const again = await store.start('generic-amd64', '9.0.4');
  assert.equal(again.state, 'ready');
  assert.equal(hits(), 1, 'the second request reused the image instead of downloading it again');

  // a brand-new store on the same folder (as after a server restart) still sees it
  const restarted = new BaseImageStore({ dir, downloadUrl: () => 'http://127.0.0.1:9/never' });
  assert.equal((await restarted.list()).length, 1);
  assert.ok(await restarted.resolveReady('generic-amd64', '9.0.4'));
});

test('a failed download is reported and can be cleared', async (t) => {
  const { store } = await fixture(t, { status: 404 });
  const started = await store.start('generic-amd64', '0.0.0');
  const failed = await settled(store, started.id);
  assert.equal(failed.state, 'error');
  assert.match(failed.error ?? '', /HTTP 404/);
  assert.equal(await store.resolveReady('generic-amd64', '0.0.0'), undefined);

  await store.remove(started.id);
  assert.equal((await store.list()).length, 0);
});

test('an archive without a disk image is rejected', async (t) => {
  const { store } = await fixture(t, { archive: buildStoredZip('readme.txt', Buffer.from('hello')) });
  const started = await store.start('generic-amd64', '1.0.0');
  const failed = await settled(store, started.id);
  assert.equal(failed.state, 'error');
  assert.match(failed.error ?? '', /does not contain a disk image/);
});

test('only one large download runs at a time and a running one cannot be removed', async (t) => {
  const { store } = await fixture(t, { delayMs: 150 });
  const first = await store.start('generic-amd64', '9.0.4');
  await assert.rejects(store.start('raspberrypi4-64', '9.0.4'), BaseImageConflictError);
  await assert.rejects(store.remove(first.id), BaseImageConflictError);

  const same = await store.start('generic-amd64', '9.0.4');
  assert.equal(same.id, first.id, 'asking for the same image again joins the running download');

  const done = await settled(store, first.id);
  assert.equal(done.state, 'ready', done.error);
});

test('removing a ready image deletes it from disk', async (t) => {
  const { store, dir } = await fixture(t);
  const started = await store.start('generic-amd64', '9.0.4');
  await settled(store, started.id);

  await store.remove(started.id);
  assert.equal(await store.resolveReady('generic-amd64', '9.0.4'), undefined);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(store.remove('../outside'), BaseImageValidationError);
});

test('OS versions are listed from the catalog, newest first, and cached', async () => {
  clearCatalogCache();
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        d: [
          { raw_version: '9.0.4+rev1', semver: '9.0.4+rev1' },
          { raw_version: '9.0.4', semver: '9.0.4' },
          { raw_version: 'bad version!', semver: 'x' },
          { raw_version: '9.0.4', semver: '9.0.4' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const options = { apiUrl: 'https://catalog.example.test/', fetchImpl };
  assert.deepEqual(await listOsVersions('generic-amd64', options), ['9.0.4+rev1', '9.0.4']);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/catalog\.example\.test\/v6\/release\?/);
  assert.match(urls[0], /slug%20eq%20'generic-amd64'/);

  await listOsVersions('generic-amd64', options);
  assert.equal(urls.length, 1, 'second call is served from the cache');

  await assert.rejects(listOsVersions("x' or 1 eq 1", options), BaseImageValidationError);
  assert.equal(urls.length, 1, 'an invalid device type never reaches the network');
});

test('a catalog error is surfaced', async () => {
  clearCatalogCache();
  const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(
    listOsVersions('raspberrypi4-64', { apiUrl: 'https://catalog.example.test', fetchImpl }),
    /HTTP 503/,
  );
});

// keep the type import used even if assertions change
export type { BaseImage };
