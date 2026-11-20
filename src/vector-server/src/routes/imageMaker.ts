import { json, Router } from 'express';
import { buildAccessContext } from '../accessControl';
import {
  BaseImageValidationError,
  ConfigGenerationError,
  addDevice,
  generateConfig,
  getOsVersions,
  parseAddDeviceRequest,
  parseFleetConfigRequest,
} from '../imageMaker';
import authorize, { type AuthorizedLocals } from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { databaseReader } from './adminDatabase';

const router = Router();
router.use(json());

class ImageMakerForbiddenError extends Error {}

/** Registering devices and creating their keys needs the same standing as other global administration. */
const requireImageManager = async (authorization: string, auth: AuthorizedLocals['auth']): Promise<void> => {
  const context = await buildAccessContext(auth, databaseReader(authorization));
  if (context.enforcementEnabled && !context.globalAdmin) {
    throw new ImageMakerForbiddenError('Adding devices requires a global administrator.');
  }
};

const fail = (res: import('express').Response, error: unknown, fallback: string): void => {
  const message = error instanceof Error && error.message ? error.message : fallback;
  const status =
    error instanceof ImageMakerForbiddenError
      ? 403
      : error instanceof BaseImageValidationError
        ? 400
        : error instanceof ConfigGenerationError
          ? error.status
          : 502;
  res.status(status).json({ message });
};

/** One structured line per event, for whoever reads the server log. */
const audit = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify({ audit: 'device-config', at: new Date().toISOString(), ...event }));
};

const byWhom = (res: import('express').Response): string => {
  const auth = (res.locals as AuthorizedLocals).auth as { username?: string; id?: number | string };
  return String(auth.username ?? auth.id ?? 'unknown');
};

router.get('/image-maker/versions', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    res.json({ versions: await getOsVersions(req.query.deviceType) });
  } catch (error) {
    fail(res, error, 'Unable to list balenaOS versions.');
  }
});

const apiUrl = (): string => {
  const url = process.env.OPEN_BALENA_API_URL;
  if (!url) throw new ConfigGenerationError('The balena API address is not configured.', 500);
  return url;
};

/**
 * Adds one named device to a fleet: the explicit first step. It registers the device (offline until it boots) and
 * hands out nothing; config.json is then made for that device with the key created for it.
 */
router.post('/image-maker/devices', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const request = parseAddDeviceRequest(req.body);
    const device = await addDevice(apiUrl(), req.headers.authorization!, request);
    audit({ event: 'device-added', by: byWhom(res), deviceType: request.deviceType, deviceUuid: device.uuid, named: Boolean(device.name), from: req.ip });
    res.status(201).json({ device });
  } catch (error) {
    fail(res, error, 'Unable to add the device.');
  }
});

/** The config.json (and the Wi-Fi connection when asked for) to put on the boot partition of a flashed drive. */
router.post('/image-maker/config', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const request = parseFleetConfigRequest(req.body);
    const { config, device } = await generateConfig(apiUrl(), req.headers.authorization!, request);
    audit({ event: 'config-generated', by: byWhom(res), deviceType: request.deviceType, provisioning: request.provisioning, deviceUuid: device?.uuid, from: req.ip });
    if (device) res.setHeader('x-vector-device-uuid', device.uuid);
    res.setHeader('content-disposition', 'attachment; filename="config.json"');
    res.setHeader('cache-control', 'no-store');
    res.json(config);
  } catch (error) {
    fail(res, error, 'Unable to generate the config.');
  }
});

export default router;
