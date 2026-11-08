import path from 'node:path';
import { BaseImageStore } from './baseImages';
import { listOsVersions } from './catalog';
import { ImageJobs } from './configuredImage';

export * from './baseImages';
export { listOsVersions, clearCatalogCache } from './catalog';
export * from './configuredImage';

/**
 * Settings (all optional):
 * - VECTOR_BASE_IMAGES_DIR  where downloaded base images are kept (default ./data/base-images)
 * - VECTOR_OS_CATALOG_API_URL  where balenaOS versions and image downloads come from (default balena's public API)
 */
export const imageMakerSettings = () => ({
  baseImagesDir: path.resolve(process.env.VECTOR_BASE_IMAGES_DIR || 'data/base-images'),
  workDir: path.resolve(process.env.VECTOR_IMAGE_WORK_DIR || 'data/image-jobs'),
  osCatalogApiUrl: (process.env.VECTOR_OS_CATALOG_API_URL || 'https://api.balena-cloud.com').replace(/\/+$/, ''),
});

let store: BaseImageStore | undefined;

/** The shared library of downloaded base images. */
export const getBaseImageStore = (): BaseImageStore => {
  if (!store) {
    const settings = imageMakerSettings();
    store = new BaseImageStore({
      dir: settings.baseImagesDir,
      // same download endpoint the repo's end-to-end test uses; "+" must be percent-encoded
      downloadUrl: (deviceType, version) =>
        `${settings.osCatalogApiUrl}/download?deviceType=${encodeURIComponent(deviceType)}` +
        `&version=${encodeURIComponent(version)}&fileType=.zip`,
    });
  }
  return store;
};

let jobs: ImageJobs | undefined;

/** Configured images being prepared or waiting to be downloaded. */
export const getImageJobs = (): ImageJobs => {
  if (!jobs) {
    jobs = new ImageJobs({ dir: imageMakerSettings().workDir, secret: process.env.OPEN_BALENA_JWT_SECRET ?? '' });
    jobs.restore();
  }
  return jobs;
};

export const getOsVersions =(deviceType: unknown): Promise<string[]> =>
  listOsVersions(deviceType, { apiUrl: imageMakerSettings().osCatalogApiUrl });
