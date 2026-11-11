import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ImageTicket {
  id: string;
  deviceType: string;
  version: string;
  fileName: string;
  deviceUuid?: string;
  /** Who prepared it (the signed-in user), for the audit log. */
  createdBy: string;
  createdAt: number;
  /** How many times the image was started: a ticket is good for a few retries, not for unlimited copies. */
  downloads: number;
  /** The config.json to write into the image. Held in memory only, never on disk. */
  config: Record<string, unknown>;
}

export interface ImageTicketsOptions {
  /** Secret used to sign download links. */
  secret: string;
  ttlMs?: number;
  now?: () => number;
}

const LINK_LIFETIME_MS = 10 * 60 * 1000;

/**
 * A ticket is the permission to download one configured image: the answers of the wizard turned into a config.json,
 * plus a short-lived signed link. Tickets live in memory only (a restart simply asks the user to prepare again) so
 * the fleet key inside a config never reaches this server's disk, and they expire after thirty minutes.
 */
export class ImageTickets {
  private readonly tickets = new Map<string, ImageTicket>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ImageTicketsOptions) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  create(
    config: Record<string, unknown>,
    deviceType: string,
    version: string,
    deviceUuid?: string,
    createdBy = 'unknown',
  ): ImageTicket {
    this.expire();
    const id = randomBytes(16).toString('hex');
    const ticket: ImageTicket = {
      id,
      deviceType,
      version,
      deviceUuid,
      fileName: `vector-${deviceType}-${version.replace(/[^0-9A-Za-z.-]/g, '_')}.img`,
      createdBy,
      createdAt: this.now(),
      downloads: 0,
      config,
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  get(id: string): ImageTicket | undefined {
    this.expire();
    return this.tickets.get(id);
  }

  private expire(): void {
    for (const [id, ticket] of this.tickets) {
      if (this.now() - ticket.createdAt > this.ttlMs) this.tickets.delete(id);
    }
  }

  private mac(id: string, expires: number): Buffer {
    return createHmac('sha256', this.options.secret).update(`image-download:${id}:${expires}`).digest();
  }

  sign(id: string): { expires: number; signature: string } {
    const expires = this.now() + LINK_LIFETIME_MS;
    return { expires, signature: this.mac(id, expires).toString('hex') };
  }

  verify(id: string, expires: unknown, signature: unknown): boolean {
    const exp = Number(expires);
    if (!Number.isFinite(exp) || exp < this.now() || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) {
      return false;
    }
    return timingSafeEqual(this.mac(id, exp), Buffer.from(signature, 'hex'));
  }
}
