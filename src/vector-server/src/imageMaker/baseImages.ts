import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export type BaseImageState = 'downloading' | 'extracting' | 'ready' | 'error';

export interface BaseImage {
  id: string;
  deviceType: string;
  version: string;
  state: BaseImageState;
  /** Size of the archive being downloaded, when the service reports it. */
  bytesTotal?: number;
  bytesDownloaded: number;
  bytesExtracted: number;
  /** Size of the extracted disk image once ready. */
  sizeBytes?: number;
  createdAt: string;
  error?: string;
}

export class BaseImageValidationError extends Error {}
export class BaseImageConflictError extends Error {}

const DEVICE_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}--[0-9A-Za-z][0-9A-Za-z._-]{0,80}$/;

export const assertDeviceType = (value: unknown): string => {
  if (typeof value !== 'string' || !DEVICE_TYPE_PATTERN.test(value)) {
    throw new BaseImageValidationError('A valid device type slug is required.');
  }
  return value;
};

export const assertVersion = (value: unknown): string => {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new BaseImageValidationError('A valid balenaOS version is required, for example 9.0.4+rev1.');
  }
  return value;
};

/** Directory-safe identifier: "+" would be awkward in paths and URLs, so it is spelled out. */
export const baseImageId = (deviceType: string, version: string): string =>
  `${deviceType}--${version.replace(/\+/g, '_plus_')}`;

export const assertBaseImageId = (value: unknown): string => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new BaseImageValidationError('A valid base image identifier is required.');
  }
  return value;
};

export interface BaseImageStoreOptions {
  /** Folder that holds one sub-folder per base image. */
  dir: string;
  downloadUrl: (deviceType: string, version: string) => string;
  fetchImpl?: typeof fetch;
  /** How many downloads may run at once (default 1: they are large). */
  maxConcurrent?: number;
  /** Free space required, as a multiple of the archive size (archive + extracted image). Default 4.2. */
  freeSpaceFactor?: number;
}

const isActive = (image: BaseImage): boolean => image.state === 'downloading' || image.state === 'extracting';

const counter = (onBytes: (bytes: number) => void): Transform =>
  new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes(chunk.length);
      callback(null, chunk);
    },
  });

/**
 * Library of downloaded balenaOS base images. An image is downloaded once and then reused for every device that
 * needs it: `resolveReady` finds it on disk, `start` only downloads when it is missing.
 */
export class BaseImageStore {
  private readonly jobs = new Map<string, BaseImage>();

  constructor(private readonly options: BaseImageStoreOptions) {}

  private dirFor(id: string): string {
    return path.join(this.options.dir, id);
  }

  imagePathFor(id: string): string {
    return path.join(this.dirFor(id), 'balena.img');
  }

  private async readReady(id: string): Promise<BaseImage | undefined> {
    try {
      const meta = JSON.parse(await readFile(path.join(this.dirFor(id), 'meta.json'), 'utf8')) as Partial<BaseImage>;
      const image = await stat(this.imagePathFor(id));
      if (!meta.deviceType || !meta.version || !image.isFile()) {
        return undefined;
      }
      return {
        id,
        deviceType: meta.deviceType,
        version: meta.version,
        state: 'ready',
        bytesDownloaded: meta.bytesDownloaded ?? 0,
        bytesExtracted: image.size,
        bytesTotal: meta.bytesTotal,
        sizeBytes: image.size,
        createdAt: meta.createdAt ?? image.birthtime.toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  /** Every image: the ones on disk, plus downloads in progress and failed attempts. */
  async list(): Promise<BaseImage[]> {
    const images = new Map<string, BaseImage>();
    let entries: string[] = [];
    try {
      entries = await readdir(this.options.dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!ID_PATTERN.test(entry)) continue;
      const ready = await this.readReady(entry);
      if (ready) images.set(ready.id, ready);
    }
    for (const job of this.jobs.values()) {
      images.set(job.id, { ...job });
    }
    return [...images.values()].sort(
      (a, b) =>
        a.deviceType.localeCompare(b.deviceType) || b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
  }

  /** Path of the extracted disk image if this base image is already downloaded. */
  async resolveReady(deviceType: unknown, version: unknown): Promise<string | undefined> {
    const id = baseImageId(assertDeviceType(deviceType), assertVersion(version));
    return (await this.readReady(id)) ? this.imagePathFor(id) : undefined;
  }

  /** Starts a download unless the image is already on disk or already downloading. Returns immediately. */
  async start(deviceType: unknown, version: unknown): Promise<BaseImage> {
    const slug = assertDeviceType(deviceType);
    const release = assertVersion(version);
    const id = baseImageId(slug, release);

    const ready = await this.readReady(id);
    if (ready) return ready;

    const running = this.jobs.get(id);
    if (running && isActive(running)) return { ...running };

    const active = [...this.jobs.values()].filter(isActive).length;
    if (active >= (this.options.maxConcurrent ?? 1)) {
      throw new BaseImageConflictError('Another base image is already downloading. Wait for it to finish first.');
    }

    const job: BaseImage = {
      id,
      deviceType: slug,
      version: release,
      state: 'downloading',
      bytesDownloaded: 0,
      bytesExtracted: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    void this.run(job);
    return { ...job };
  }

  async remove(id: unknown): Promise<void> {
    const safeId = assertBaseImageId(id);
    const job = this.jobs.get(safeId);
    if (job && isActive(job)) {
      throw new BaseImageConflictError('This base image is still downloading.');
    }
    this.jobs.delete(safeId);
    await rm(this.dirFor(safeId), { recursive: true, force: true });
  }

  private async assertFreeSpace(dir: string, archiveBytes: number): Promise<void> {
    const needed = Math.ceil(archiveBytes * (this.options.freeSpaceFactor ?? 4.2));
    let free: number;
    try {
      const fs = await statfs(dir);
      free = fs.bavail * fs.bsize;
    } catch {
      return; // cannot tell; let the download try
    }
    if (free < needed) {
      const gb = (value: number) => (value / 1024 ** 3).toFixed(1);
      throw new Error(`Not enough disk space: about ${gb(needed)} GB is needed and ${gb(free)} GB is free.`);
    }
  }

  private extract(zipPath: string, target: string, onBytes: (bytes: number) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (openError, zipfile) => {
        if (openError || !zipfile) {
          reject(openError ?? new Error('Unable to open the downloaded archive.'));
          return;
        }
        let found = false;
        zipfile.on('error', (error) => {
          zipfile.close();
          reject(error);
        });
        zipfile.on('end', () => {
          if (!found) {
            zipfile.close();
            reject(new Error('The downloaded archive does not contain a disk image (.img).'));
          }
        });
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (found || !/\.img$/i.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }
          found = true;
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              zipfile.close();
              reject(streamError ?? new Error('Unable to read the disk image from the archive.'));
              return;
            }
            pipeline(stream, counter(onBytes), createWriteStream(target)).then(
              () => {
                zipfile.close();
                resolve();
              },
              (error) => {
                zipfile.close();
                reject(error);
              },
            );
          });
        });
        zipfile.readEntry();
      });
    });
  }

  private async run(job: BaseImage): Promise<void> {
    const dir = this.dirFor(job.id);
    const zipPart = path.join(dir, 'download.zip.part');
    const zipPath = path.join(dir, 'download.zip');
    const imagePart = path.join(dir, 'balena.img.part');
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });

      const response = await (this.options.fetchImpl ?? fetch)(this.options.downloadUrl(job.deviceType, job.version));
      if (!response.ok || !response.body) {
        throw new Error(
          `The download service answered HTTP ${response.status}. Check that this device type and version exist.`,
        );
      }
      const length = Number(response.headers.get('content-length'));
      job.bytesTotal = Number.isFinite(length) && length > 0 ? length : undefined;
      if (job.bytesTotal) {
        await this.assertFreeSpace(dir, job.bytesTotal);
      }

      await pipeline(
        Readable.fromWeb(response.body as never),
        counter((bytes) => {
          job.bytesDownloaded += bytes;
        }),
        createWriteStream(zipPart),
      );
      await rename(zipPart, zipPath);

      job.state = 'extracting';
      await this.extract(zipPath, imagePart, (bytes) => {
        job.bytesExtracted += bytes;
      });
      await rename(imagePart, this.imagePathFor(job.id));
      await rm(zipPath, { force: true });

      const size = (await stat(this.imagePathFor(job.id))).size;
      await writeFile(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          deviceType: job.deviceType,
          version: job.version,
          bytesTotal: job.bytesTotal,
          bytesDownloaded: job.bytesDownloaded,
          sizeBytes: size,
          createdAt: job.createdAt,
        }),
      );
      this.jobs.delete(job.id);
    } catch (error) {
      job.state = 'error';
      job.error = error instanceof Error ? error.message : 'The download failed.';
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
