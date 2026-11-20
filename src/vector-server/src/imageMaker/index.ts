import { listOsVersions } from './catalog';
import { assertDeviceType } from './validation';

export * from './validation';
export { listOsVersions, clearCatalogCache } from './catalog';
export * from './configuredImage';

/**
 * Settings (all optional):
 * - VECTOR_OS_CATALOG_API_URL  where the list of balenaOS versions comes from (default balena's public API)
 *
 * Vector does not download or store OS images: it prepares config.json, and the OS is installed from balena's own
 * download page or balenaEtcher.
 */
export const imageMakerSettings = () => ({
  osCatalogApiUrl: (process.env.VECTOR_OS_CATALOG_API_URL || 'https://api.balena-cloud.com').replace(/\/+$/, ''),
});

/** Released balenaOS versions of a device type, newest first. */
export const getOsVersions = async (deviceType: unknown, fetchImpl?: typeof fetch): Promise<string[]> =>
  listOsVersions(assertDeviceType(deviceType), { apiUrl: imageMakerSettings().osCatalogApiUrl, fetchImpl });
