import { createHmac } from 'node:crypto';

/**
 * Where the delta server lives. Set VECTOR_DELTA_URL to override; otherwise it is the API address with
 * "api." swapped for "delta." (the same hostname devices get as deltaEndpoint).
 */
export const deltaServerUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = env.VECTOR_DELTA_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const api = env.OPEN_BALENA_API_URL?.trim();
  if (!api) throw new Error('The balena API address is not configured.');
  const url = new URL(api);
  url.hostname = url.hostname.replace(/^api\./, 'delta.');
  return url.origin;
};

/** Same derivation the delta container uses: HMAC-SHA256 of "delta-records" keyed by the JSON web token secret. */
export const deltaRecordsKey = (secret: string): string =>
  createHmac('sha256', secret).update('delta-records').digest('hex');

export interface DeltaRecord {
  id: string;
  srcImage: string;
  destImage: string;
  deltaImage: string;
  status: 'building' | 'ready' | 'failed';
  error?: string;
  firstRequestedAt: number;
  lastRequestedAt: number;
  requests: number;
  devices: string[];
  startedAt?: number;
  finishedAt?: number;
  buildMs?: number;
  pullMs?: number;
  diffMs?: number;
  pushMs?: number;
  srcBytes?: number;
  destBytes?: number;
  deltaBytes?: number;
}

export class DeltaUnavailableError extends Error {}

export const fetchDeltaRecords = async (env: NodeJS.ProcessEnv = process.env): Promise<DeltaRecord[]> => {
  const secret = env.OPEN_BALENA_JWT_SECRET;
  if (!secret) throw new Error('The JSON web token secret is not configured.');
  let response: Response;
  try {
    response = await fetch(`${deltaServerUrl(env)}/api/records`, {
      headers: { 'x-delta-records-key': deltaRecordsKey(secret) },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new DeltaUnavailableError('The delta server is not reachable. Is the delta service running?');
  }
  if (response.status === 503 || response.status === 401) {
    throw new DeltaUnavailableError('The delta server rejected the request. Restart it so it picks up the current secrets.');
  }
  if (!response.ok) throw new DeltaUnavailableError(`The delta server answered ${response.status}.`);
  const body = (await response.json()) as { records?: DeltaRecord[] };
  return Array.isArray(body.records) ? body.records : [];
};
