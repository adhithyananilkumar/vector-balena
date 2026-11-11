import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { canDownloadOsImage, clearCatalogCache, clearDownloadableCache, getOsVersions, osDownloadUrl } from './index';
import { isDownloadable } from './streamedImage';

/** Pretends to be balena: lists three releases, and only offers a download for the ones in `offered`. */
const fakeBalena = (offered: string[], calls: string[] = []): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/v6/release')) {
      return new Response(JSON.stringify({ d: [{ raw_version: '2026.7.2' }, { raw_version: '9.0.3+rev2' }, { raw_version: '9.0.2' }] }));
    }
    const version = decodeURIComponent(new URL(url).searchParams.get('version') ?? '');
    assert.equal((init?.headers as Record<string, string>).range, 'bytes=0-0', 'only one byte is requested');
    return offered.includes(version) ? new Response('x', { status: 206 }) : new Response('nope', { status: 404 });
  }) as typeof fetch;

beforeEach(() => {
  clearCatalogCache();
  clearDownloadableCache();
});

describe('isDownloadable', () => {
  it('is true for an answered range request and false for 404s and network errors', async () => {
    assert.equal(await isDownloadable('https://x.test/a', (async () => new Response('x', { status: 206 })) as unknown as typeof fetch), true);
    assert.equal(await isDownloadable('https://x.test/a', (async () => new Response('', { status: 404 })) as unknown as typeof fetch), false);
    assert.equal(await isDownloadable('https://x.test/a', (async () => { throw new Error('offline'); }) as unknown as typeof fetch), false);
  });
});

describe('getOsVersions', () => {
  it('lists only the versions balena offers a download for, in the catalog order', async () => {
    const versions = await getOsVersions('raspberrypi4-64', fakeBalena(['9.0.3+rev2', '9.0.2']));
    assert.deepEqual(versions, ['9.0.3+rev2', '9.0.2']);
  });

  it('remembers the answer instead of asking balena again', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeBalena(['9.0.2'], calls);
    assert.equal(await canDownloadOsImage('raspberrypi4-64', '9.0.2', fetchImpl), true);
    assert.equal(await canDownloadOsImage('raspberrypi4-64', '9.0.2', fetchImpl), true);
    assert.equal(calls.filter((url) => url.includes('/download')).length, 1);
    assert.equal(await canDownloadOsImage('raspberrypi4-64', '2026.7.2', fetchImpl), false);
  });

  it('rejects a bad device type before any request', async () => {
    await assert.rejects(getOsVersions('../x', fakeBalena([])), /device type/);
  });

  it('builds the download address with the version percent-encoded', () => {
    assert.match(osDownloadUrl('raspberrypi4-64', '9.0.3+rev2'), /version=9\.0\.3%2Brev2&fileType=\.zip$/);
  });
});
