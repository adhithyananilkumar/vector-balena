import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { interact } from 'balena-image-fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import {
  addDevice,
  parseAddDeviceRequest,
  fetchFleetConfig,
  generateConfig,
  parseFleetConfigRequest,
  readConfigFromImage,
  wifiConnectionFile,
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

describe('Wi-Fi in a disk image', () => {
  it('builds the NetworkManager connection balenaOS reads', () => {
    const file = wifiConnectionFile({ wifiSsid: 'Home Net', wifiKey: 'pa\\ss' }) ?? '';
    assert.match(file, /^\[connection\]\nid=resin-wifi-01\ntype=wifi\n/);
    assert.match(file, /\nssid=Home Net\n/);
    assert.match(file, /\[wifi-security\]\nauth-alg=open\nkey-mgmt=wpa-psk\npsk=pa\\\\ss\n/);
    assert.match(file, /\[ipv4\]\nmethod=auto\n/);
  });

  it('leaves out the security section for an open network and writes nothing without a network', () => {
    assert.doesNotMatch(wifiConnectionFile({ wifiSsid: 'open' }) ?? '', /wifi-security/);
    assert.equal(wifiConnectionFile({ apiEndpoint: 'x' }), undefined);
  });

  it('writes the connection into the boot partition next to config.json without changing the image size', async () => {
    const before = (await stat(baseImage)).size;
    await writeConfigToImage(baseImage, { applicationId: 7, wifiSsid: 'Lab', wifiKey: 'secret123' });
    assert.equal((await stat(baseImage)).size, before);
    const stored = await interact(baseImage, 1, (fs) =>
      new Promise<string>((resolve, reject) => fs.readFile('/system-connections/resin-wifi-01', { encoding: 'utf8', flag: 'r' }, (e, c) => (e ? reject(e) : resolve(c)))),
    );
    assert.match(stored, /ssid=Lab\n/);
    assert.match(stored, /psk=secret123\n/);
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

describe('generateConfig for an already registered device', () => {
  const uuid = 'a'.repeat(32);
  const ok = { appId: 7, deviceType: 'raspberrypi4-64', version: '9.0.3+rev2', provisioning: 'device', deviceUuid: uuid };

  const api = (options: { fleet?: number; found?: boolean; keyStatus?: number; keyBody?: string } = {}) => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.test', '')}`);
      if (url.endsWith('/download-config')) return new Response(JSON.stringify({ apiKey: 'shared-provisioning-key', apiEndpoint: 'https://api.test' }));
      if (url.includes('/v7/device?')) {
        const row = { id: 5, uuid, created_at: '2026-11-01T10:00:00.000Z', belongs_to__application: [{ __id: options.fleet ?? 7 }] };
        return new Response(JSON.stringify({ d: options.found === false ? [] : [row] }));
      }
      if (url.endsWith('/api-key/device/5/device-key')) return new Response(options.keyBody ?? '"device-key-123"', { status: options.keyStatus ?? 200 });
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  it('gives the device its own key in place of the shared one, without registering anything', async () => {
    const { fetchImpl, calls } = api();
    const { config, device } = await generateConfig('https://api.test', 'Bearer t', parseFleetConfigRequest(ok), fetchImpl);
    assert.equal(config.apiKey, undefined, 'the shared provisioning key is not in a single-device image');
    assert.equal(config.deviceApiKey, 'device-key-123');
    assert.equal(config.uuid, uuid);
    assert.equal(config.deviceId, 5);
    assert.equal(config.registered_at, Math.floor(Date.parse('2026-11-01T10:00:00.000Z') / 1000), 'keeps the original registration time');
    assert.deepEqual(device, { id: 5, uuid });
    assert.ok(!calls.some((call) => call.includes('/device/register')), 'no second device is registered');
  });

  it('accepts a key the API sends without quotes', async () => {
    const { config } = await generateConfig('https://api.test', 'Bearer t', parseFleetConfigRequest(ok), api({ keyBody: 'plain-key-456' }).fetchImpl);
    assert.equal(config.deviceApiKey, 'plain-key-456');
  });

  it('refuses a device from another fleet, an unknown device and a refused key', async () => {
    await assert.rejects(generateConfig('https://api.test', 'Bearer t', parseFleetConfigRequest(ok), api({ fleet: 9 }).fetchImpl), /does not belong to the chosen fleet/);
    await assert.rejects(generateConfig('https://api.test', 'Bearer t', parseFleetConfigRequest(ok), api({ found: false }).fetchImpl), /not found/);
    await assert.rejects(generateConfig('https://api.test', 'Bearer t', parseFleetConfigRequest(ok), api({ keyStatus: 403 }).fetchImpl), /may not create a key/);
  });

  it('validates the uuid and ignores it unless a single device is asked for', () => {
    assert.throws(() => parseFleetConfigRequest({ ...ok, deviceUuid: "x' or 1 eq 1 or uuid eq '" }), /valid device uuid/);
    assert.equal(parseFleetConfigRequest({ ...ok, provisioning: 'fleet' }).deviceUuid, undefined);
    assert.equal(parseFleetConfigRequest({ ...ok, deviceUuid: 'b'.repeat(62) }).deviceUuid, 'b'.repeat(62));
  });
});

describe('adding a device as a separate step', () => {
  const ok = { appId: 7, deviceType: 'raspberrypi4-64', version: '9.0.3+rev2' };

  const api = (options: { registerStatus?: number; renameStatus?: number } = {}) => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace('https://api.test', '');
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/download-config')) return new Response(JSON.stringify({ apiKey: 'shared-provisioning-key', apiEndpoint: 'https://api.test' }));
      if (url.endsWith('/device/register')) {
        return options.registerStatus
          ? new Response('no', { status: options.registerStatus })
          : new Response(JSON.stringify({ id: 9, uuid: 'c'.repeat(32), api_key: 'device-key' }));
      }
      if (url.startsWith('/v7/device(9)')) return new Response('{}', { status: options.renameStatus ?? 200 });
      return new Response('unexpected', { status: 500 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  it('registers one device and hands out no key or configuration', async () => {
    const { fetchImpl, calls } = api();
    const device = await addDevice('https://api.test', 'Bearer t', parseAddDeviceRequest(ok), fetchImpl);
    assert.deepEqual(device, { id: 9, uuid: 'c'.repeat(32), name: undefined });
    assert.equal(calls.filter((call) => call.includes('/device/register')).length, 1);
    assert.ok(!JSON.stringify(device).includes('key'), 'no key leaves the server');
  });

  it('names the device, as the signed-in user, and reports the name', async () => {
    const { fetchImpl, calls } = api();
    const device = await addDevice('https://api.test', 'Bearer t', parseAddDeviceRequest({ ...ok, name: '  Lab Pi 1 ' }), fetchImpl);
    assert.equal(device.name, 'Lab Pi 1');
    assert.ok(calls.includes('PATCH /v7/device(9)'));
  });

  it('still reports the device when only the rename failed, without claiming a name', async () => {
    const device = await addDevice('https://api.test', 'Bearer t', parseAddDeviceRequest({ ...ok, name: 'Lab Pi 1' }), api({ renameStatus: 500 }).fetchImpl);
    assert.equal(device.uuid, 'c'.repeat(32));
    assert.equal(device.name, undefined);
  });

  it('says so when the device cannot be registered', async () => {
    await assert.rejects(addDevice('https://api.test', 'Bearer t', parseAddDeviceRequest(ok), api({ registerStatus: 403 }).fetchImpl), /could not be registered \(HTTP 403\)/);
  });

  it('validates the answers', () => {
    assert.throws(() => parseAddDeviceRequest({ ...ok, appId: 'x' }), /Choose a fleet/);
    assert.throws(() => parseAddDeviceRequest({ ...ok, version: '../x' }), /version/);
    assert.throws(() => parseAddDeviceRequest({ ...ok, name: 'x'.repeat(65) }), /1 to 64 characters/);
    assert.throws(() => parseAddDeviceRequest({ ...ok, name: 'a\nb' }), /control characters/);
    assert.throws(() => parseAddDeviceRequest({ ...ok, name: 5 }), /not valid/);
    assert.equal(parseAddDeviceRequest({ ...ok, name: '' }).name, undefined);
  });
});
