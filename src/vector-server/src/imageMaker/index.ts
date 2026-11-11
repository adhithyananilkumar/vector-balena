import { listOsVersions } from './catalog';
import { ImageTickets } from './imageTickets';
import { isDownloadable } from './streamedImage';
import { assertDeviceType } from './validation';

export * from './validation';
export { listOsVersions, clearCatalogCache } from './catalog';
export * from './configuredImage';
export * from './imageTickets';
export * from './streamedImage';

/**
 * Settings (all optional):
 * - VECTOR_OS_CATALOG_API_URL  where balenaOS versions and image downloads come from (default balena's public API)
 * - VECTOR_IMAGE_TMP_DIR  scratch folder for the boot partition while an image streams (default: system temp)
 * - VECTOR_IMAGE_MAX_STREAMS  how many images may stream at once (default 2)
 *
 * Images themselves are never stored on this server: they stream from balena's download service to the browser.
 */
export const imageMakerSettings = () => ({
  osCatalogApiUrl: (process.env.VECTOR_OS_CATALOG_API_URL || 'https://api.balena-cloud.com').replace(/\/+$/, ''),
  tmpDir: process.env.VECTOR_IMAGE_TMP_DIR || undefined,
  maxStreams: Math.max(1, Number(process.env.VECTOR_IMAGE_MAX_STREAMS) || 2),
});

/** The balenaOS download for a device type and version ("+" must be percent-encoded). */
export const osDownloadUrl = (deviceType: string, version: string): string =>
  `${imageMakerSettings().osCatalogApiUrl}/download?deviceType=${encodeURIComponent(deviceType)}` +
  `&version=${encodeURIComponent(version)}&fileType=.zip`;

let tickets: ImageTickets | undefined;

/** Permissions to download configured images (in memory only). */
export const getImageTickets = (): ImageTickets => {
  if (!tickets) tickets = new ImageTickets({ secret: process.env.OPEN_BALENA_JWT_SECRET ?? '' });
  return tickets;
};

const downloadable = new Map<string, { at: number; ok: boolean }>();
const DOWNLOADABLE_TTL_MS = 10 * 60 * 1000;

/** Cached check that balena offers this image (see isDownloadable). */
export const canDownloadOsImage = async (deviceType: string, version: string, fetchImpl?: typeof fetch): Promise<boolean> => {
  const key = `${deviceType}|${version}`;
  const hit = downloadable.get(key);
  if (hit && Date.now() - hit.at < DOWNLOADABLE_TTL_MS) return hit.ok;
  const ok = await isDownloadable(osDownloadUrl(deviceType, version), fetchImpl);
  downloadable.set(key, { at: Date.now(), ok });
  return ok;
};

export const clearDownloadableCache = (): void => downloadable.clear();

/** Versions of a device type that can actually be downloaded, newest first. */
export const getOsVersions = async (deviceType: unknown, fetchImpl?: typeof fetch): Promise<string[]> => {
  const slug = assertDeviceType(deviceType);
  const listed = await listOsVersions(slug, { apiUrl: imageMakerSettings().osCatalogApiUrl, fetchImpl });
  const keep = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < listed.length) {
      const version = listed[next++];
      if (await canDownloadOsImage(slug, version, fetchImpl)) keep.add(version);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return listed.filter((version) => keep.has(version));
};
