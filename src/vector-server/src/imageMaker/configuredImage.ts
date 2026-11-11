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

  const provisioningKey = config.apiKey;
  if (typeof provisioningKey !== 'string' || !provisioningKey) {
    throw new ConfigGenerationError('The API did not return a provisioning key, so the device cannot be registered.');
  }
  const uuid = randomBytes(16).toString('hex');
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/device/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provisioningKey}` },
      body: JSON.stringify({ application: request.appId, device_type: request.deviceType, uuid }),
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

/** Writes config.json into the boot partition (partition 1) of a balenaOS disk image, in place. */
export const writeConfigToImage = async (imagePath: string, config: Record<string, unknown>): Promise<void> => {
  const data = Buffer.from(JSON.stringify(config, null, 2));
  await interact(imagePath, 1, async (fs) => {
    await new Promise<void>((resolve, reject) => fs.writeFile('/config.json', data, { flag: 'w' }, (e) => (e ? reject(e) : resolve())));
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
