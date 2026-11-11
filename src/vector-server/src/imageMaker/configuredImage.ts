import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { interact } from 'balena-image-fs';
import { assertDeviceType, assertVersion, BaseImageValidationError } from './validation';

export class ConfigGenerationError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export interface FleetConfigRequest {
  appId: number;
  deviceType: string;
  version: string;
  developmentMode: boolean;
  /** fleet: any device can use the image; device: the device is registered now and gets its own key. */
  provisioning: 'fleet' | 'device';
  /** With provisioning "device": an already registered device to make the image for (otherwise a new one is registered). */
  deviceUuid?: string;
  network: 'ethernet' | 'wifi';
  wifiSsid?: string;
  wifiKey?: string;
  /** Minutes between update checks. */
  appUpdatePollInterval?: number;
  /** Resolvers the device uses first (needed when the server's names only exist on a private DNS). */
  dnsServers?: string[];
}

const text = (value: unknown, max: number): string | undefined => {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new BaseImageValidationError('A text setting is invalid.');
  }
  return value;
};

/** Accepts "10.0.0.1, 10.0.0.2" (or an array) and returns validated IP addresses, or undefined when empty. */
const parseDnsServers = (value: unknown): string[] | undefined => {
  if (value == null || value === '') return undefined;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!items) throw new BaseImageValidationError('DNS servers must be IP addresses.');
  const servers = items.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  if (!servers.length) return undefined;
  if (servers.length > 4 || servers.some((server) => isIP(server) === 0)) {
    throw new BaseImageValidationError('DNS servers must be up to 4 valid IP addresses.');
  }
  return servers;
};

/** A device uuid as the API prints it: 32 or 62 hex digits. */
const parseDeviceUuid = (value: unknown): string | undefined => {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !/^([0-9a-f]{32}|[0-9a-f]{62})$/.test(value)) {
    throw new BaseImageValidationError('That is not a valid device uuid.');
  }
  return value;
};

/** Validates the wizard's answers; nothing else is ever forwarded to the API. */
export const parseFleetConfigRequest = (body: unknown): FleetConfigRequest => {
  const input = (body ?? {}) as Record<string, unknown>;
  const appId = Number(input.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new BaseImageValidationError('Choose a fleet.');
  const network = input.network === 'wifi' ? 'wifi' : 'ethernet';
  const wifiSsid = text(input.wifiSsid, 32);
  const wifiKey = text(input.wifiKey, 63);
  if (network === 'wifi' && !wifiSsid) throw new BaseImageValidationError('A Wi-Fi network name is required.');
  let appUpdatePollInterval: number | undefined;
  if (input.appUpdatePollInterval != null && input.appUpdatePollInterval !== '') {
    appUpdatePollInterval = Number(input.appUpdatePollInterval);
    if (!Number.isInteger(appUpdatePollInterval) || appUpdatePollInterval < 1 || appUpdatePollInterval > 1440) {
      throw new BaseImageValidationError('The update check interval must be 1 to 1440 minutes.');
    }
  }
  const dnsServers = parseDnsServers(input.dnsServers);
  return {
    appId,
    deviceType: assertDeviceType(input.deviceType),
    version: assertVersion(input.version),
    developmentMode: input.developmentMode === true,
    provisioning: input.provisioning === 'device' ? 'device' : 'fleet',
    deviceUuid: input.provisioning === 'device' ? parseDeviceUuid(input.deviceUuid) : undefined,
    network,
    wifiSsid: network === 'wifi' ? wifiSsid : undefined,
    wifiKey: network === 'wifi' ? wifiKey : undefined,
    appUpdatePollInterval,
    dnsServers,
  };
};

/**
 * Asks the API's own /download-config route for a fleet-wide config.json, as the signed-in user.
 * The API fills in endpoints, the provisioning key and the root CA, so nothing is guessed here.
 */
export const fetchFleetConfig = async (
  apiUrl: string,
  authorization: string,
  request: FleetConfigRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> => {
  const body: Record<string, unknown> = {
    appId: String(request.appId),
    deviceType: request.deviceType,
    version: request.version,
    network: request.network,
    developmentMode: request.developmentMode,
  };
  if (request.network === 'wifi') {
    body.wifiSsid = request.wifiSsid;
    if (request.wifiKey) body.wifiKey = request.wifiKey;
  }
  if (request.appUpdatePollInterval) body.appUpdatePollInterval = request.appUpdatePollInterval;

  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/download-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ConfigGenerationError('The balena API could not be reached.');
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new ConfigGenerationError('You do not have access to that fleet.', 403);
  }
  if (!response.ok) {
    throw new ConfigGenerationError(`The balena API refused to generate the config (HTTP ${response.status}).`);
  }
  const config = (await response.json()) as unknown;
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigGenerationError('The balena API returned an unexpected config.');
  }
  // balenaOS reads dnsServers as one space-separated string
  if (request.dnsServers?.length) (config as Record<string, unknown>).dnsServers = request.dnsServers.join(' ');
  return config as Record<string, unknown>;
};

export interface GeneratedConfig {
  config: Record<string, unknown>;
  device?: { id: number; uuid: string };
}

interface RegisteredDevice {
  id: number;
  uuid: string;
  api_key: string;
}

/** Registers one device in a fleet with the fleet's provisioning key. */
const registerWithKey = async (
  apiUrl: string,
  provisioningKey: string,
  appId: number,
  deviceType: string,
  fetchImpl: typeof fetch,
): Promise<RegisteredDevice> => {
  const uuid = randomBytes(16).toString('hex');
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/device/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provisioningKey}` },
      body: JSON.stringify({ application: appId, device_type: deviceType, uuid }),
    });
  } catch {
    throw new ConfigGenerationError('The balena API could not be reached.');
  }
  if (!response.ok) {
    throw new ConfigGenerationError(`The device could not be registered (HTTP ${response.status}).`);
  }
  const registered = (await response.json()) as { id?: unknown; uuid?: unknown; api_key?: unknown };
  if (typeof registered.id !== 'number' || typeof registered.uuid !== 'string' || typeof registered.api_key !== 'string') {
    throw new ConfigGenerationError('The API returned an unexpected registration.');
  }
  return { id: registered.id, uuid: registered.uuid, api_key: registered.api_key };
};

export interface AddDeviceRequest {
  appId: number;
  deviceType: string;
  version: string;
  name?: string;
}

/** Validates the answers of the "add device" step. */
export const parseAddDeviceRequest = (body: unknown): AddDeviceRequest => {
  const input = (body ?? {}) as Record<string, unknown>;
  const appId = Number(input.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new BaseImageValidationError('Choose a fleet.');
  let name: string | undefined;
  if (input.name != null && input.name !== '') {
    if (typeof input.name !== 'string') throw new BaseImageValidationError('The device name is not valid.');
    name = input.name.trim();
    if (name.length < 1 || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new BaseImageValidationError('A device name is 1 to 64 characters, with no control characters.');
    }
  }
  return { appId, deviceType: assertDeviceType(input.deviceType), version: assertVersion(input.version), name };
};

/**
 * Adds one device to a fleet, and nothing else: no image, no configuration is handed out. The device shows in the
 * fleet as offline until it boots with a config made for it. With a name, the device is renamed from the random one.
 */
export const addDevice = async (
  apiUrl: string,
  authorization: string,
  request: AddDeviceRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; uuid: string; name?: string }> => {
  const config = await fetchFleetConfig(
    apiUrl,
    authorization,
    { appId: request.appId, deviceType: request.deviceType, version: request.version, developmentMode: false, provisioning: 'device', network: 'ethernet' },
    fetchImpl,
  );
  const provisioningKey = config.apiKey;
  if (typeof provisioningKey !== 'string' || !provisioningKey) {
    throw new ConfigGenerationError('The API did not return a provisioning key, so the device cannot be registered.');
  }
  const registered = await registerWithKey(apiUrl, provisioningKey, request.appId, request.deviceType, fetchImpl);
  if (request.name) {
    let renamed: Response | undefined;
    try {
      renamed = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/v7/device(${registered.id})`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ device_name: request.name }),
      });
    } catch {
      renamed = undefined;
    }
    // the device exists either way: a failed rename is reported by leaving the name out of the answer
    if (!renamed?.ok) return { id: registered.id, uuid: registered.uuid };
  }
  return { id: registered.id, uuid: registered.uuid, name: request.name };
};

/**
 * Fleet-wide config, or, for device provisioning, the same config after registering one device and swapping the
 * shared provisioning key for that device's own key (what `balena config generate --device` does).
 */
export const generateConfig = async (
  apiUrl: string,
  authorization: string,
  request: FleetConfigRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratedConfig> => {
  const config = await fetchFleetConfig(apiUrl, authorization, request, fetchImpl);
  if (request.provisioning !== 'device') return { config };
  if (request.deviceUuid) return configForExistingDevice(apiUrl, authorization, request, config, fetchImpl);

  const provisioningKey = config.apiKey;
  if (typeof provisioningKey !== 'string' || !provisioningKey) {
    throw new ConfigGenerationError('The API did not return a provisioning key, so the device cannot be registered.');
  }
  const registered = await registerWithKey(apiUrl, provisioningKey, request.appId, request.deviceType, fetchImpl);
  const { apiKey: _shared, ...rest } = config;
  return {
    config: {
      ...rest,
      deviceId: registered.id,
      uuid: registered.uuid,
      deviceApiKey: registered.api_key,
      registered_at: Math.floor(Date.now() / 1000),
    },
    device: { id: registered.id, uuid: registered.uuid },
  };
};

const keyfileValue = (value: string): string => value.replace(/\\/g, '\\\\');

/**
 * The NetworkManager connection balenaOS reads from the boot partition (`system-connections/resin-wifi-01`).
 * balenaOS ignores `wifiSsid` and `wifiKey` inside config.json: it is this file that makes the device join the
 * network, as `balena os configure` writes it. Returns undefined when the config has no Wi-Fi network.
 */
export const wifiConnectionFile = (config: Record<string, unknown>): string | undefined => {
  const ssid = typeof config.wifiSsid === 'string' ? config.wifiSsid : '';
  if (!ssid) return undefined;
  const key = typeof config.wifiKey === 'string' ? config.wifiKey : '';
  const lines = ['[connection]', 'id=resin-wifi-01', 'type=wifi', '', '[wifi]', 'hidden=true', 'mode=infrastructure', `ssid=${keyfileValue(ssid)}`, ''];
  if (key) lines.push('[wifi-security]', 'auth-alg=open', 'key-mgmt=wpa-psk', `psk=${keyfileValue(key)}`, '');
  lines.push('[ipv4]', 'method=auto', '', '[ipv6]', 'addr-gen-mode=stable-privacy', 'method=auto', '');
  return lines.join('\n');
};

/** Writes config.json (and the Wi-Fi connection, when the config names a network) into the boot partition. */
export const writeConfigToImage = async (imagePath: string, config: Record<string, unknown>): Promise<void> => {
  const data = Buffer.from(JSON.stringify(config, null, 2));
  const wifi = wifiConnectionFile(config);
  await interact(imagePath, 1, async (fs) => {
    await new Promise<void>((resolve, reject) => fs.writeFile('/config.json', data, { flag: 'w' }, (e) => (e ? reject(e) : resolve())));
    if (wifi) {
      await new Promise<void>((resolve) => fs.mkdir('/system-connections', () => resolve())); // exists on balenaOS; harmless when it does
      await new Promise<void>((resolve, reject) =>
        fs.writeFile('/system-connections/resin-wifi-01', Buffer.from(wifi), { flag: 'w' }, (e) => (e ? reject(e) : resolve())),
      );
    }
  });
};

/** Reads config.json back out of a disk image (used to verify a write). */
export const readConfigFromImage = async (imagePath: string): Promise<Record<string, unknown>> =>
  interact(imagePath, 1, (fs) =>
    new Promise<Record<string, unknown>>((resolve, reject) =>
      fs.readFile('/config.json', { encoding: 'utf8', flag: 'r' }, (e, content) => {
        if (e) return reject(e);
        try {
          resolve(JSON.parse(content));
        } catch (parseError) {
          reject(parseError);
        }
      }),
    ),
  );

const apiBase = (apiUrl: string): string => apiUrl.replace(/\/+$/, '');

/**
 * The config for a device that is already registered (for example one registered earlier, whose image was never
 * made): the fleet config with a new key for that one device in place of the shared provisioning key, which is what
 * `balena config generate --device` does. The device must belong to the fleet the image is for.
 */
const configForExistingDevice = async (
  apiUrl: string,
  authorization: string,
  request: FleetConfigRequest,
  config: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<GeneratedConfig> => {
  const base = apiBase(apiUrl);
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch {
      throw new ConfigGenerationError('The balena API could not be reached.');
    }
  };

  const lookup = await call(
    `/v7/device?$select=id,uuid,created_at,belongs_to__application&$filter=uuid%20eq%20'${request.deviceUuid}'`,
  );
  if (lookup.status === 401 || lookup.status === 403) throw new ConfigGenerationError('You do not have access to that device.', 403);
  if (!lookup.ok) throw new ConfigGenerationError(`The device could not be looked up (HTTP ${lookup.status}).`);
  const found = ((await lookup.json()) as { d?: Array<{ id?: number; uuid?: string; created_at?: string; belongs_to__application?: { __id?: number } | Array<{ __id?: number }> }> }).d?.[0];
  if (!found || typeof found.id !== 'number' || typeof found.uuid !== 'string') {
    throw new ConfigGenerationError('That device was not found.', 404);
  }
  const fleet = Array.isArray(found.belongs_to__application) ? found.belongs_to__application[0]?.__id : found.belongs_to__application?.__id;
  if (fleet !== request.appId) {
    throw new ConfigGenerationError('That device does not belong to the chosen fleet.', 400);
  }

  const keyResponse = await call(`/api-key/device/${found.id}/device-key`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Vector image', description: 'Created by Add device' }),
  });
  if (keyResponse.status === 401 || keyResponse.status === 403) throw new ConfigGenerationError('You may not create a key for that device.', 403);
  if (!keyResponse.ok) throw new ConfigGenerationError(`A key for the device could not be created (HTTP ${keyResponse.status}).`);
  const raw = (await keyResponse.text()).trim();
  const key = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  if (!key || /[\s{}]/.test(key)) throw new ConfigGenerationError('The API returned an unexpected device key.');

  const { apiKey: _shared, ...rest } = config;
  const created = found.created_at ? Math.floor(new Date(found.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return {
    config: { ...rest, deviceId: found.id, uuid: found.uuid, deviceApiKey: key, registered_at: Number.isFinite(created) ? created : Math.floor(Date.now() / 1000) },
    device: { id: found.id, uuid: found.uuid },
  };
};
