import { assertDeviceType } from './validation';

export interface CatalogOptions {
  /** Where balenaOS releases are listed. Defaults to balena's public API. */
  apiUrl: string;
  fetchImpl?: typeof fetch;
  /** How long a listing is cached (default 10 minutes). */
  ttlMs?: number;
}

const cache = new Map<string, { at: number; versions: string[] }>();
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export const clearCatalogCache = (): void => cache.clear();

/**
 * Available balenaOS versions for a device type, newest first. Uses the same public OData query the balena CLI
 * and SDK use for `os versions`.
 */
export const listOsVersions = async (deviceType: unknown, options: CatalogOptions): Promise<string[]> => {
  const slug = assertDeviceType(deviceType); // safe to inline: restricted to [a-z0-9._-]
  const apiUrl = options.apiUrl.replace(/\/+$/, '');
  const key = `${apiUrl}|${slug}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (options.ttlMs ?? 10 * 60 * 1000)) {
    return hit.versions;
  }

  const filter =
    `(is_final eq true) and (is_invalidated eq false) and (status eq 'success') and ` +
    `(belongs_to__application/any(a:(a/is_host eq true) and (a/is_for__device_type/any(dt:dt/slug eq '${slug}'))))`;
  const url =
    `${apiUrl}/v6/release?$select=raw_version,semver&$filter=${filter.replace(/ /g, '%20')}` +
    `&$orderby=created_at%20desc&$top=40`;

  const response = await (options.fetchImpl ?? fetch)(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`The balenaOS catalog answered HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { d?: Array<{ raw_version?: string; semver?: string }> };
  const versions = [
    ...new Set(
      (body.d ?? [])
        .map((release) => String(release.raw_version ?? release.semver ?? ''))
        .filter((version) => VERSION_PATTERN.test(version)),
    ),
  ];
  cache.set(key, { at: Date.now(), versions });
  return versions;
};
