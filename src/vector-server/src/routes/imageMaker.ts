import { Transform } from 'node:stream';
import { createGzip } from 'node:zlib';
import { assertDeviceType, assertVersion } from '../imageMaker';
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
  openBaseImage,
  openBootPatch,
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

/** Image sizes learned from finished downloads (balena does not announce them), for progress bars. */
const knownSizes = new Map<string, number>();
const sizeKey = (deviceType: string, version: string): string => `${deviceType}|${version}`;

const requireDownloadable = async (deviceType: string, version: string): Promise<void> => {
  if (!(await canDownloadOsImage(deviceType, version))) {
    throw new StreamedImageError(
      `balena does not offer a download of balenaOS ${version} for ${deviceType}. Choose another version.`,
      404,
    );
  }
};

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
    await requireDownloadable(request.deviceType, request.version);
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

/**
 * A download link for the plain balenaOS image of a device type and version, to keep as a local base image on the
 * user's computer. Nothing about a fleet is in it.
 */
router.post('/image-maker/os-downloads', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const deviceType = assertDeviceType(req.body?.deviceType);
    const version = assertVersion(req.body?.version);
    await requireDownloadable(deviceType, version);
    const auth = (res.locals as AuthorizedLocals).auth as { username?: string; id?: number | string };
    const by = String(auth.username ?? auth.id ?? 'unknown');
    const ticket = getImageTickets().createBase(deviceType, version, by);
    audit({ event: 'base-image-prepared', ticket: ticket.id, by, deviceType, version, from: req.ip });
    res.status(201).json({ job: publicTicket(ticket), downloadPath: downloadPathFor(ticket), sizeBytes: knownSizes.get(sizeKey(deviceType, version)) });
  } catch (error) {
    fail(res, error, 'Unable to prepare the download.');
  }
});

/**
 * What turns a local copy of the base image into a flash-ready one: the few blocks of the boot partition that change
 * when this fleet's config.json is written (and, when asked, a device is registered). The image itself is not
 * downloaded: only its first few megabytes are read from balena.
 */
router.post('/image-maker/boot-patch', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const request = parseFleetConfigRequest(req.body);
    await requireDownloadable(request.deviceType, request.version);
    const { config, device } = await generateConfig(apiUrl(), req.headers.authorization!, request);
    const auth = (res.locals as AuthorizedLocals).auth as { username?: string; id?: number | string };
    const by = String(auth.username ?? auth.id ?? 'unknown');
    const started = Date.now();
    const patch = await openBootPatch(osDownloadUrl(request.deviceType, request.version), config, { tmpDir: imageMakerSettings().tmpDir });
    const patchBytes = patch.patches.reduce((total, part) => total + part.data.length, 0);
    audit({
      event: 'boot-patch',
      by,
      deviceType: request.deviceType,
      version: request.version,
      provisioning: request.provisioning,
      deviceUuid: device?.uuid,
      patchBytes,
      ms: Date.now() - started,
      from: req.ip,
    });
    res.setHeader('cache-control', 'no-store');
    res.json({
      bootEnd: patch.bootEnd,
      headSha256: patch.headSha256,
      fileName: `vector-${request.deviceType}-${request.version.replace(/[^0-9A-Za-z.-]/g, '_')}.img`,
      patches: patch.patches.map((part) => ({ offset: part.offset, data: part.data.toString('base64') })),
      device,
      sizeBytes: knownSizes.get(sizeKey(request.deviceType, request.version)),
    });
  } catch (error) {
    fail(res, error, 'Unable to prepare the image.');
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
  const from = req.query.from === undefined ? 0 : Number(req.query.from);
  if (!Number.isSafeInteger(from) || from < 0) {
    res.status(400).json({ message: 'Resume position is not valid.' });
    return;
  }
  streaming += 1;
  if (from === 0) ticket.downloads += 1; // resuming an interrupted download does not use up a start
  const started = Date.now();
  let sent = 0;
  const base = { ticket: ticket.id, by: ticket.createdBy, deviceType: ticket.deviceType, version: ticket.version, deviceUuid: ticket.deviceUuid };
  try {
    const url = osDownloadUrl(ticket.deviceType, ticket.version);
    const options = { tmpDir: settings.tmpDir, skip: from };
    const { stream, size, verification } = ticket.config
      ? await openConfiguredImage(url, ticket.config, options)
      : await openBaseImage(url, options);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${ticket.fileName}"`);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-accel-buffering', 'no');
    // A disk image compresses about five to one: sending it gzipped makes the download several times faster on a
    // slow link. The browser undoes it invisibly, so positions (resume) and the saved bytes are those of the image.
    const gzip = /gzip/.test(req.get('accept-encoding') ?? '');
    res.setHeader('vary', 'Accept-Encoding');
    if (gzip) res.setHeader('content-encoding', 'gzip');
    else if (size) res.setHeader('content-length', String(size - from));
    res.setHeader('x-vector-resumed-from', String(from));
    audit({ ...base, kind: ticket.kind, event: 'download-started', size, resumedFrom: from || undefined, from: req.ip });
    await pipeline(stream, countBytes((total) => (sent = total)), ...(gzip ? [createGzip({ level: 3 })] : []), res);
    const verified = await verification;
    if (from === 0 && sent > 0) knownSizes.set(sizeKey(ticket.deviceType, ticket.version), sent);
    audit({ ...base, kind: ticket.kind, event: 'download-finished', bytes: sent, resumedFrom: from || undefined, verified, ms: Date.now() - started });
  } catch (error) {
    audit({ ...base, kind: ticket.kind, event: 'download-failed', resumedFrom: from || undefined, bytes: sent, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) fail(res, error, 'Unable to stream the image.');
    else res.destroy();
  } finally {
    streaming -= 1;
  }
});

export default router;
