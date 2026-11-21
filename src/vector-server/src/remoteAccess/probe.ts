import type { Duplex } from 'node:stream';
import type { RemoteIdentity } from './auth';

/**
 * "Is this device answering right now?" — opens a CONNECT through the VPN proxy to the device's SSH port and
 * closes it as soon as the device accepts. Nothing is sent to the device. This proves the tunnel is alive end to
 * end instead of trusting the VPN server's last known state, which can lag by a keepalive timeout.
 */
export interface ProbeResult {
  reachable: boolean;
  /** Round trip of the CONNECT, when reachable. */
  latencyMs?: number;
  checkedAt: string;
  /** Why the device did not answer. */
  reason?: string;
}

export type TunnelOpener = (identity: RemoteIdentity, deviceUuid: string, signal: AbortSignal) => Promise<Duplex>;
export type Authorizer = (identity: RemoteIdentity, deviceUuid: string, signal: AbortSignal) => Promise<void>;

/** Results are shared for a few seconds so many viewers of one device cause one probe. */
export const PROBE_CACHE_MS = 5_000;
/** A successful authorization is reused for a minute (two API requests saved per probe). */
export const AUTHORIZATION_CACHE_MS = 60_000;

const reasonOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|aborted/i.test(message)) return 'The device did not answer in time.';
  if (/\((404|503|502|504)\)/.test(message)) return 'The VPN server has no working tunnel to the device.';
  if (/\(40[13]\)/.test(message)) return 'Access to the device was refused.';
  return message;
};

export class DeviceProber {
  private results = new Map<string, { at: number; result: Promise<ProbeResult> }>();
  private authorized = new Map<string, number>();

  constructor(
    private readonly open: TunnelOpener,
    private readonly authorize: Authorizer,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(now: number): void {
    if (this.results.size > 1000)
      for (const [key, entry] of this.results) if (now - entry.at > PROBE_CACHE_MS) this.results.delete(key);
    if (this.authorized.size > 5000)
      for (const [key, expires] of this.authorized) if (expires < now) this.authorized.delete(key);
  }

  async probe(identity: RemoteIdentity, deviceUuid: string): Promise<ProbeResult> {
    const now = this.now();
    this.prune(now);
    const authKey = `${identity.userId}:${identity.token}:${deviceUuid}`;
    const authorizedUntil = this.authorized.get(authKey);
    if (authorizedUntil === undefined || authorizedUntil <= now) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        await this.authorize(identity, deviceUuid, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      this.authorized.set(authKey, now + AUTHORIZATION_CACHE_MS);
    }

    const cached = this.results.get(deviceUuid);
    if (cached && now - cached.at < PROBE_CACHE_MS) return cached.result;
    const result = this.run(identity, deviceUuid);
    this.results.set(deviceUuid, { at: now, result });
    return result;
  }

  private async run(identity: RemoteIdentity, deviceUuid: string): Promise<ProbeResult> {
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const socket = await this.open(identity, deviceUuid, controller.signal);
      socket.destroy();
      return { reachable: true, latencyMs: this.now() - started, checkedAt: new Date(started).toISOString() };
    } catch (error) {
      return { reachable: false, checkedAt: new Date(started).toISOString(), reason: reasonOf(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}
