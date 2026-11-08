import { json, Router } from 'express';
import { buildAccessContext } from '../accessControl';
import {
  ConfigGenerationError,
  generateConfig,
  getImageJobs,
  parseFleetConfigRequest,
  type ImageJob,
  BaseImageConflictError,
  BaseImageValidationError,
  getBaseImageStore,
  getOsVersions,
} from '../imageMaker';
import authorize, { type AuthorizedLocals } from '../middleware/authorize';
import dosProtect from '../middleware/dosProtect';
import { databaseReader } from './adminDatabase';

const router = Router();
router.use(json());

class ImageMakerForbiddenError extends Error {}

/** Managing OS images uses disk and bandwidth, so it needs the same standing as other global administration. */
const requireImageManager = async (authorization: string, auth: AuthorizedLocals['auth']): Promise<void> => {
  const context = await buildAccessContext(auth, databaseReader(authorization));
  if (context.enforcementEnabled && !context.globalAdmin) {
    throw new ImageMakerForbiddenError('Managing base images requires a global administrator.');
  }
};

const fail = (res: import('express').Response, error: unknown, fallback: string): void => {
  const message = error instanceof Error && error.message ? error.message : fallback;
  const status =
    error instanceof ImageMakerForbiddenError
      ? 403
      : error instanceof BaseImageValidationError
        ? 400
        : error instanceof BaseImageConflictError
          ? 409
          : error instanceof ConfigGenerationError
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

router.get('/image-maker/base-images', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    res.json({ images: await getBaseImageStore().list() });
  } catch (error) {
    fail(res, error, 'Unable to list base images.');
  }
});

router.post('/image-maker/base-images', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const image = await getBaseImageStore().start(req.body?.deviceType, req.body?.version);
    res.status(image.state === 'ready' ? 200 : 202).json({ image });
  } catch (error) {
    fail(res, error, 'Unable to start the base image download.');
  }
});

router.delete('/image-maker/base-images/:id', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    await getBaseImageStore().remove(req.params.id);
    res.status(204).end();
  } catch (error) {
    fail(res, error, 'Unable to remove the base image.');
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

const JOB_ID = /^[0-9a-f]{32}$/;

const publicJob = (job: ImageJob) => ({
  id: job.id,
  state: job.state,
  fileName: job.fileName,
  sizeBytes: job.sizeBytes,
  error: job.error,
  deviceUuid: job.deviceUuid,
});

/** A ready-to-flash image: the shared base image with this fleet's config.json written into a private copy. */
router.post('/image-maker/images', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const request = parseFleetConfigRequest(req.body);
    const base = await getBaseImageStore().resolveReady(request.deviceType, request.version);
    if (!base) {
      throw new BaseImageConflictError('That OS version is not downloaded yet. Download it under Base images first.');
    }
    // checked before registering anything, so a busy queue does not leave an orphan device behind
    getImageJobs().assertIdle();
    const { config, device } = await generateConfig(apiUrl(), req.headers.authorization!, request);
    const job = getImageJobs().create(base, config, request.deviceType, request.version, device?.uuid);
    res.status(202).json({ job: publicJob(job) });
  } catch (error) {
    fail(res, error, 'Unable to prepare the image.');
  }
});

router.get('/image-maker/images/:id', ...dosProtect, authorize, async (req, res) => {
  try {
    await requireImageManager(req.headers.authorization!, (res.locals as AuthorizedLocals).auth);
    const jobs = getImageJobs();
    const job = JOB_ID.test(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!job) {
      res.status(404).json({ message: 'That image is no longer available. Prepare it again.' });
      return;
    }
    const link = job.state === 'ready' ? jobs.sign(job.id) : undefined;
    res.json({
      job: publicJob(job),
      downloadPath: link && `/image-maker/images/${job.id}/download?expires=${link.expires}&signature=${link.signature}`,
    });
  } catch (error) {
    fail(res, error, 'Unable to read the image status.');
  }
});

/**
 * Plain browser/Etcher download, so no Authorization header: access is a short-lived signed link that only an
 * authorised administrator can obtain from the status route. Range requests are supported (resumable downloads).
 */
router.get('/image-maker/images/:id/download', ...dosProtect, (req, res) => {
  const jobs = getImageJobs();
  const job = JOB_ID.test(req.params.id) ? jobs.get(req.params.id) : undefined;
  if (!job || job.state !== 'ready' || !jobs.verify(job.id, req.query.expires, req.query.signature)) {
    res.status(404).json({ message: 'This download link is invalid or has expired.' });
    return;
  }
  res.setHeader('cache-control', 'no-store');
  res.download(job.path, job.fileName);
});

export default router;
