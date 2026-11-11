import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { json, Router } from 'express';
import { buildAccessContext } from '../accessControl';
import {
  BaseImageValidationError,
  canDownloadOsImage,
  ConfigGenerationError,
  generateConfig,
  getImageTickets,
  getOsVersions,
  imageMakerSettings,
  openConfiguredImage,
  osDownloadUrl,
  parseFleetConfigRequest,
  StreamedImageError,
  type ImageTicket,
} from '../imageMaker';
import authorize, { type AuthorizedLocals } from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { databaseReader } from './adminDatabase';

const router = Router();
router.use(json());

class ImageMakerForbiddenError extends Error {}
class TooBusyError extends Error {}

/** Preparing OS images registers devices and uses bandwidth, so it needs the same standing as other global administration. */
const requireImageManager = async (authorization: string, auth: AuthorizedLocals['auth']): Promise<void> => {
  const context = await buildAccessContext(auth, databaseReader(authorization));
  if (context.enforcementEnabled && !context.globalAdmin) {
    throw new ImageMakerForbiddenError('Preparing OS images requires a global administrator.');
  }
};

const fail = (res: import('express').Response, error: unknown, fallback: string): void => {
  const message = error instanceof Error && error.message ? error.message : fallback;
  const status =
    error instanceof ImageMakerForbiddenError
      ? 403
      : error instanceof BaseImageValidationError
        ? 400
        : error instanceof TooBusyError
          ? 429
          : error instanceof ConfigGenerationError || error instanceof StreamedImageError
            ? error.status
            : 502;
  res.status(status).json({ message });
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

/** Just the config.json, for devices that are already flashed (write it to the boot partition). */
router.post('/image-maker/config', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const { config, device } = await generateConfig(apiUrl(), req.headers.authorization!, parseFleetConfigRequest(req.body));
    if (device) res.setHeader('x-vector-device-uuid', device.uuid);
    res.setHeader('content-disposition', 'attachment; filename="config.json"');
    res.setHeader('cache-control', 'no-store');
    res.json(config);
  } catch (error) {
    fail(res, error, 'Unable to generate the config.');
  }
});

const TICKET_ID = /^[0-9a-f]{32}$/;

const publicTicket = (ticket: ImageTicket) => ({
  id: ticket.id,
  state: 'ready' as const,
  fileName: ticket.fileName,
  deviceUuid: ticket.deviceUuid,
});

const downloadPathFor = (ticket: ImageTicket): string => {
  const link = getImageTickets().sign(ticket.id);
  return `/image-maker/images/${ticket.id}/download?expires=${link.expires}&signature=${link.signature}`;
};

/**
 * Prepares a flash-ready image: builds this fleet's config.json (registering a device when asked to) and returns a
 * short-lived download link. The image itself is streamed on download and is never stored on this server.
 */
router.post('/image-maker/images', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const request = parseFleetConfigRequest(req.body);
    // before anything is registered: a device registered for an image that cannot be downloaded would be an orphan
    if (!(await canDownloadOsImage(request.deviceType, request.version))) {
      throw new StreamedImageError(
        `balena does not offer a download of balenaOS ${request.version} for ${request.deviceType}. Choose another version.`,
        404,
      );
    }
    const { config, device } = await generateConfig(apiUrl(), req.headers.authorization!, request);
    const auth = (res.locals as AuthorizedLocals).auth as { username?: string; id?: number | string };
    const by = String(auth.username ?? auth.id ?? 'unknown');
    const ticket = getImageTickets().create(config, request.deviceType, request.version, device?.uuid, by);
    audit({ event: 'image-prepared', ticket: ticket.id, by, deviceType: request.deviceType, version: request.version, provisioning: request.provisioning, deviceUuid: device?.uuid, from: req.ip });
    res.status(201).json({ job: publicTicket(ticket), downloadPath: downloadPathFor(ticket) });
  } catch (error) {
    fail(res, error, 'Unable to prepare the image.');
  }
});

/** A fresh download link for an image prepared earlier (links last ten minutes, the image thirty). */
router.get('/image-maker/images/:id', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const ticket = TICKET_ID.test(req.params.id) ? getImageTickets().get(req.params.id) : undefined;
    if (!ticket) {
      res.status(404).json({ message: 'That image is no longer available. Prepare it again.' });
      return;
    }
    res.json({ job: publicTicket(ticket), downloadPath: downloadPathFor(ticket) });
  } catch (error) {
    fail(res, error, 'Unable to read the image status.');
  }
});

let streaming = 0;
const MAX_STARTS_PER_TICKET = 5;

/** One structured line per event, for whoever reads the server log: who prepared or downloaded which image. */
const audit = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify({ audit: 'os-image', at: new Date().toISOString(), ...event }));
};

const countBytes = (onBytes: (total: number) => void): Transform => {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      onBytes(total);
      callback(null, chunk);
    },
  });
};

/**
 * The image, streamed. No Authorization header (a browser download or a save-to-folder fetch can use it as it is):
 * access is a short-lived signed link that only an authorised administrator can obtain. The disk image is unzipped
 * from balena's download service on the fly with config.json written into its boot partition, and goes straight to
 * the browser; only the boot partition passes through a temporary file, deleted before the rest is sent.
 *
 * The exact size is announced up front (Content-Length) and the data is checked against the zip's CRC-32, so a
 * download that is cut short or corrupted fails visibly instead of leaving a plausible but broken file.
 */
router.get('/image-maker/images/:id/download', ...dosProtect, async (req, res) => {
  const tickets = getImageTickets();
  const ticket = TICKET_ID.test(req.params.id) ? tickets.get(req.params.id) : undefined;
  if (!ticket || !tickets.verify(ticket.id, req.query.expires, req.query.signature)) {
    res.status(404).json({ message: 'This download link is invalid or has expired.' });
    return;
  }
  const settings = imageMakerSettings();
  if (ticket.downloads >= MAX_STARTS_PER_TICKET) {
    res.status(429).json({ message: 'This image was downloaded too many times. Prepare it again.' });
    return;
  }
  if (streaming >= settings.maxStreams) {
    res.status(429).json({ message: 'Other images are being downloaded right now. Try again in a minute.' });
    return;
  }
  streaming += 1;
  ticket.downloads += 1;
  const started = Date.now();
  let sent = 0;
  const base = { ticket: ticket.id, by: ticket.createdBy, deviceType: ticket.deviceType, version: ticket.version, deviceUuid: ticket.deviceUuid };
  try {
    const { stream, size, verification } = await openConfiguredImage(osDownloadUrl(ticket.deviceType, ticket.version), ticket.config, {
      tmpDir: settings.tmpDir,
    });
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${ticket.fileName}"`);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-accel-buffering', 'no');
    if (size) res.setHeader('content-length', String(size));
    audit({ ...base, event: 'download-started', size, from: req.ip });
    await pipeline(stream, countBytes((total) => (sent = total)), res);
    audit({ ...base, event: 'download-finished', bytes: sent, verified: await verification, ms: Date.now() - started });
  } catch (error) {
    audit({ ...base, event: 'download-failed', bytes: sent, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) fail(res, error, 'Unable to stream the image.');
    else res.destroy();
  } finally {
    streaming -= 1;
  }
});

export default router;
