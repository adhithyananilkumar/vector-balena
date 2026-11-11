import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import {
  fetchFleetConfig,
  generateConfig,
  parseFleetConfigRequest,
  readConfigFromImage,
  writeConfigToImage,
} from './configuredImage';

let dir: string;
let baseImage: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vector-config-'));
  baseImage = path.join(dir, 'base.img');
  // 16 MB MBR disk with a FAT16 "resin-boot" partition holding a placeholder config.json
  await writeFile(baseImage, gunzipSync(await readFile(path.join(__dirname, 'fixtures', 'tiny.img.gz'))));
});
after(() => rm(dir, { recursive: true, force: true }));

describe('parseFleetConfigRequest', () => {
  const ok = { appId: 7, deviceType: 'generic-amd64', version: '9.0.4+rev1' };

  it('accepts a minimal request and defaults to ethernet', () => {
    const parsed = parseFleetConfigRequest(ok);
    assert.equal(parsed.network, 'ethernet');
    assert.equal(parsed.developmentMode, false);
  });

  it('rejects bad fleets, versions, wifi without a name and silly intervals', () => {
    assert.throws(() => parseFleetConfigRequest({ ...ok, appId: 'x' }));
    assert.throws(() => parseFleetConfigRequest({ ...ok, appId: -1 }));
    assert.throws(() => parseFleetConfigRequest({ ...ok, version: '../etc' }));
    assert.throws(() => parseFleetConfigRequest({ ...ok, network: 'wifi' }));
    assert.throws(() => parseFleetConfigRequest({ ...ok, appUpdatePollInterval: 0 }));
    assert.throws(() => parseFleetConfigRequest({ ...ok, wifiSsid: 'a\nb', network: 'wifi' }));
  });

  it('drops wifi settings for ethernet and keeps them for wifi', () => {
    assert.equal(parseFleetConfigRequest({ ...ok, wifiSsid: 'home' }).wifiSsid, undefined);
    assert.equal(parseFleetConfigRequest({ ...ok, network: 'wifi', wifiSsid: 'home', wifiKey: 'pw' }).wifiKey, 'pw');
  });
});

describe('fetchFleetConfig', () => {
  it('posts the answers to /download-config with the caller\'s own authorization', async () => {
    let seen: { auth?: string; body?: Record<string, unknown>; url?: string } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.headers.authorization === 'Bearer good') {
          seen = { auth: req.headers.authorization, body: JSON.parse(raw), url: req.url };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ applicationId: 7, balenaRootCA: 'abc' }));
        } else {
          res.statusCode = 401;
          res.end('no');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const request = parseFleetConfigRequest({ appId: 7, deviceType: 'generic-amd64', version: '9.0.4+rev1', developmentMode: true });
      const config = await fetchFleetConfig(url, 'Bearer good', request);
      assert.equal(config.balenaRootCA, 'abc');
      assert.equal(seen.url, '/download-config');
      assert.equal(seen.body?.appId, '7');
      assert.equal(seen.body?.developmentMode, true);
      await assert.rejects(fetchFleetConfig(url, 'Bearer bad', request), /access to that fleet/);
    } finally {
      server.close();
    }
  });
});

describe('generateConfig for one device', () => {
  it('registers a device with the provisioning key and swaps in the device key', async () => {
    const calls: Array<{ url?: string; auth?: string; body: Record<string, unknown> }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/download-config') res.end(JSON.stringify({ applicationId: 7, apiKey: 'PROV', balenaRootCA: 'ca' }));
        else res.statusCode = 201, res.end(JSON.stringify({ id: 42, uuid: (JSON.parse(raw) as { uuid: string }).uuid, api_key: 'DEVKEY' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const request = parseFleetConfigRequest({ appId: 7, deviceType: 'generic-amd64', version: '9.0.4+rev1', provisioning: 'device' });
      const { config, device } = await generateConfig(url, 'Bearer user', request);
      assert.equal(calls[1].url, '/device/register');
      assert.equal(calls[1].auth, 'Bearer PROV');
      assert.match(String(calls[1].body.uuid), /^[0-9a-f]{32}$/);
      assert.equal(config.deviceApiKey, 'DEVKEY');
      assert.equal(config.deviceId, 42);
      assert.equal(config.uuid, device?.uuid);
      assert.equal('apiKey' in config, false, 'the shared provisioning key must not ship with a device-specific image');
      assert.equal(config.balenaRootCA, 'ca');

      const fleet = await generateConfig(url, 'Bearer user', parseFleetConfigRequest({ appId: 7, deviceType: 'generic-amd64', version: '9.0.4+rev1' }));
      assert.equal(fleet.device, undefined);
      assert.equal(fleet.config.apiKey, 'PROV');
      assert.equal(calls.filter((c) => c.url === '/device/register').length, 1, 'fleet-wide registers nothing');
    } finally {
      server.close();
    }
  });
});

describe('config.json in a disk image', () => {
  it('writes a config larger than the placeholder and reads it back', async () => {
    const config = { applicationId: 7, apiEndpoint: 'https://api.example.test', balenaRootCA: 'x'.repeat(6000) };
    await writeConfigToImage(baseImage, config);
    assert.deepEqual(await readConfigFromImage(baseImage), config);
  });
});

describe('dnsServers', () => {
  const ok = { appId: 7, deviceType: 'generic-amd64', version: '9.0.4+rev1' };

  it('accepts comma or space separated IP addresses and rejects anything else', () => {
    assert.deepEqual(parseFleetConfigRequest({ ...ok, dnsServers: '10.0.0.1, 8.8.8.8' }).dnsServers, ['10.0.0.1', '8.8.8.8']);
    assert.equal(parseFleetConfigRequest({ ...ok, dnsServers: '' }).dnsServers, undefined);
    assert.throws(() => parseFleetConfigRequest({ ...ok, dnsServers: 'dns.example.com' }), /IP addresses/);
    assert.throws(() => parseFleetConfigRequest({ ...ok, dnsServers: '1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 9.9.9.9' }), /IP addresses/);
  });

  it('writes them into the generated config as one space separated string', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ apiEndpoint: 'x' }), { status: 200 })) as unknown as typeof fetch;
    const { config } = await generateConfig('https://api.test', 'Bearer t', parseFleetConfigRequest({ ...ok, dnsServers: '10.0.2.2,1.1.1.1' }), fetchImpl);
    assert.equal(config.dnsServers, '10.0.2.2 1.1.1.1');
  });
});
