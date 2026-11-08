import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { interact } from 'balena-image-fs';
import { assertDeviceType, assertVersion, BaseImageValidationError } from './baseImages';

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

export type ImageJobState = 'building' | 'ready' | 'error';

export interface ImageJob {
  id: string;
  state: ImageJobState;
  deviceType: string;
  version: string;
  fileName: string;
  sizeBytes?: number;
  error?: string;
  deviceUuid?: string;
  createdAt: number;
  path: string;
}

export interface ImageJobsOptions {
  dir: string;
  /** Secret used to sign download links. */
  secret: string;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Builds configured images one at a time: copies the shared base image, writes config.json into the copy,
 * and hands out short-lived signed download links. Copies are deleted after they expire, so the provisioning
 * key inside them does not linger on disk.
 */
export class ImageJobs {
  private readonly jobs = new Map<string, ImageJob>();
  private chain: Promise<void> = Promise.resolve();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ImageJobsOptions) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Called once at start. Finished, unexpired images are restored (a server restart must not make a user prepare
   * the image again, which would register a second device); interrupted or expired ones are deleted.
   */
  restore(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.options.dir);
    } catch {
      return; // directory does not exist yet
    }
    const keep = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const job = JSON.parse(readFileSync(path.join(this.options.dir, entry), 'utf8')) as ImageJob;
        if (
          /^[0-9a-f]{32}$/.test(job.id) &&
          job.state === 'ready' &&
          this.now() - job.createdAt <= this.ttlMs &&
          job.path === path.join(this.options.dir, `${job.id}.img`) &&
          existsSync(job.path)
        ) {
          this.jobs.set(job.id, job);
          keep.add(entry).add(`${job.id}.img`);
        }
      } catch {
        /* unreadable metadata: discard */
      }
    }
    for (const entry of entries) if (!keep.has(entry)) rmSync(path.join(this.options.dir, entry), { force: true });
  }

  private persist(job: ImageJob): void {
    try {
      mkdirSync(this.options.dir, { recursive: true });
      writeFileSync(path.join(this.options.dir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
    } catch {
      /* the image still works for this run */
    }
  }

  get(id: string): ImageJob | undefined {
    this.expire();
    return this.jobs.get(id);
  }

  assertIdle(): void {
    this.expire();
    if ([...this.jobs.values()].some((job) => job.state === 'building')) {
      throw new BaseImageValidationError('Another image is being prepared; try again when it finishes.');
    }
  }

  create(baseImagePath: string, config: Record<string, unknown>, deviceType: string, version: string, deviceUuid?: string): ImageJob {
    this.expire();
    if ([...this.jobs.values()].some((job) => job.state === 'building')) {
      throw new BaseImageValidationError('Another image is being prepared; try again when it finishes.');
    }
    const id = randomBytes(16).toString('hex');
    const job: ImageJob = {
      id,
      state: 'building',
      deviceType,
      version,
      deviceUuid,
      fileName: `vector-${deviceType}-${version.replace(/[^0-9A-Za-z.-]/g, '_')}.img`,
      createdAt: this.now(),
      path: path.join(this.options.dir, `${id}.img`),
    };
    this.jobs.set(id, job);
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(this.options.dir, { recursive: true });
        await copyFile(baseImagePath, job.path);
        await writeConfigToImage(job.path, config);
        job.sizeBytes = (await stat(job.path)).size;
        job.state = 'ready';
        this.persist(job);
      } catch (error) {
        job.state = 'error';
        job.error = error instanceof Error ? error.message : 'The image could not be prepared.';
        await rm(job.path, { force: true });
      }
    });
    return job;
  }

  private expire(): void {
    for (const [id, job] of this.jobs) {
      if (job.state !== 'building' && this.now() - job.createdAt > this.ttlMs) {
        this.jobs.delete(id);
        void rm(job.path, { force: true });
        void rm(path.join(this.options.dir, `${id}.json`), { force: true });
      }
    }
  }

  /** Waits until queued work is done (used by tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private mac(id: string, expires: number): Buffer {
    return createHmac('sha256', this.options.secret).update(`image-download:${id}:${expires}`).digest();
  }

  sign(id: string): { expires: number; signature: string } {
    const expires = this.now() + 10 * 60 * 1000;
    return { expires, signature: this.mac(id, expires).toString('hex') };
  }

  verify(id: string, expires: unknown, signature: unknown): boolean {
    const exp = Number(expires);
    if (!Number.isFinite(exp) || exp < this.now() || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) {
      return false;
    }
    return timingSafeEqual(this.mac(id, exp), Buffer.from(signature, 'hex'));
  }
}
