import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { clearCatalogCache, getOsVersions } from './index';

const fakeBalena = (): typeof fetch =>
  (async () => new Response(JSON.stringify({ d: [{ raw_version: '2026.7.2' }, { raw_version: '9.0.3+rev2' }, { raw_version: '9.0.2' }] }))) as unknown as typeof fetch;

beforeEach(() => clearCatalogCache());

describe('getOsVersions', () => {
  it('lists the released versions in the catalog order', async () => {
    assert.deepEqual(await getOsVersions('raspberrypi4-64', fakeBalena()), ['2026.7.2', '9.0.3+rev2', '9.0.2']);
  });

  it('rejects a bad device type before any request', async () => {
    await assert.rejects(getOsVersions('../x', fakeBalena()), /device type/);
  });
});
