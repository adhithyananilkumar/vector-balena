import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { readConfigFromImage, writeConfigToImage } from './configuredImage';

/**
 * A configured balenaOS image that is never stored on this server.
 *
 * The balenaOS download is a zip holding one disk image. It is unzipped on the fly and sent to the browser as it
 * arrives. The only part held back is the start of the disk, up to the end of the first (boot) partition, which is
 * where config.json lives. That region (tens of megabytes) goes through a short-lived temporary file so the fleet's
 * config.json can be written into it, then it is sent first, followed by the untouched rest of the image.
 */

export class StreamedImageError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

const SECTOR = 512;
/** Boot partitions are 40 to 256 MB; anything far beyond that is not a balenaOS image. */
export const MAX_HEAD_BYTES = 768 * 1024 * 1024;

export type PartitionEnd = { end: number } | { needBytes: number };

/** Where the first partition ends, read from the MBR or, for GPT disks, the GPT. */
export const firstPartitionEnd = (head: Buffer): PartitionEnd => {
  if (head.length < SECTOR) return { needBytes: SECTOR };
  if (head.readUInt16LE(510) !== 0xaa55) throw new StreamedImageError('The download is not a disk image (no partition table).');

  const type = head[446 + 4];
  if (type !== 0xee) {
    const start = head.readUInt32LE(446 + 8);
    const sectors = head.readUInt32LE(446 + 12);
    if (type === 0 || sectors === 0) throw new StreamedImageError('The disk image has no first partition.');
    return { end: (start + sectors) * SECTOR };
  }

  // GPT: header in the second sector, partition entries wherever it says
  if (head.length < 2 * SECTOR) return { needBytes: 2 * SECTOR };
  if (head.toString('ascii', SECTOR, SECTOR + 8) !== 'EFI PART') throw new StreamedImageError('The disk image has an invalid GPT.');
  const entriesLba = Number(head.readBigUInt64LE(SECTOR + 72));
  const entrySize = head.readUInt32LE(SECTOR + 84);
  if (entrySize < 128 || entrySize > 1024 || entriesLba < 2 || entriesLba > 4096) {
    throw new StreamedImageError('The disk image has an unsupported GPT.');
  }
  const offset = entriesLba * SECTOR;
  if (head.length < offset + entrySize) return { needBytes: offset + entrySize };
  const first = Number(head.readBigUInt64LE(offset + 32));
  const last = Number(head.readBigUInt64LE(offset + 40));
  if (last < first || first === 0) throw new StreamedImageError('The disk image has no first partition.');
  return { end: (last + 1) * SECTOR };
};

/** Collects exactly `count` bytes from an async byte source; the source is positioned right after them. */
class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);
  done = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async take(count: number): Promise<Buffer> {
    while (this.pending.length < count && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.pending = this.pending.length ? Buffer.concat([this.pending, next.value]) : next.value;
    }
    if (this.pending.length < count) throw new StreamedImageError('The download ended unexpectedly.');
    const out = this.pending.subarray(0, count);
    this.pending = this.pending.subarray(count);
    return out;
  }

  /** Everything not yet taken, including what is still to arrive. */
  async *rest(): AsyncGenerator<Buffer> {
    if (this.pending.length) {
      const first = this.pending;
      this.pending = Buffer.alloc(0);
      yield first;
    }
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        return;
      }
      yield next.value;
    }
  }

  async close(): Promise<void> {
    this.done = true;
    await this.iterator.return?.();
  }
}

const ZIP_LOCAL_HEADER = 0x04034b50;

export interface ZipTrailer {
  /** Size of the disk image once unzipped. */
  size: number;
  crc32: number;
}

/** Keeps a damaged archive from making the server read without end after the compressed data. */
const MAX_TRAILER_BYTES = 4 * 1024 * 1024;

/**
 * The CRC-32 and size that follow the compressed data of an entry written in streaming style ("data descriptor"),
 * with or without the optional signature, and with 32- or 64-bit sizes. The central directory header that comes
 * next tells the two layouts apart.
 */
export const parseDataDescriptor = (tail: Buffer): ZipTrailer | undefined => {
  const at = tail.length >= 4 && tail.readUInt32LE(0) === 0x08074b50 ? 4 : 0;
  if (tail.length < at + 12) return undefined;
  const crc = tail.readUInt32LE(at);
  if (tail.length >= at + 16 && tail.readUInt32LE(at + 12) === CENTRAL_HEADER) {
    return { crc32: crc, size: tail.readUInt32LE(at + 8) };
  }
  if (tail.length >= at + 24 && tail.readUInt32LE(at + 20) === CENTRAL_HEADER) {
    return { crc32: crc, size: Number(tail.readBigUInt64LE(at + 12)) };
  }
  return undefined;
};

/**
 * Decompressed bytes of the first entry of a zip, read as a stream (no need for the central directory). `trailer`
 * settles when the data has been read to its end with the size and CRC-32 the archive records for it, or with
 * undefined when they cannot be found.
 */
export const zipFirstEntry = async (
  source: AsyncIterable<Buffer>,
): Promise<{ name: string; data: AsyncGenerator<Buffer>; trailer: Promise<ZipTrailer | undefined> }> => {
  const reader = new ByteReader(source);
  const fixed = await reader.take(30);
  if (fixed.readUInt32LE(0) !== ZIP_LOCAL_HEADER) throw new StreamedImageError('The download is not a zip archive.');
  const flags = fixed.readUInt16LE(6);
  const method = fixed.readUInt16LE(8);
  let compressedSize = fixed.readUInt32LE(18);
  const headerSize = fixed.readUInt32LE(22);
  const nameLength = fixed.readUInt16LE(26);
  const extraLength = fixed.readUInt16LE(28);
  const name = (await reader.take(nameLength)).toString('utf8');
  const extra = await reader.take(extraLength);
  if (flags & 0x1) throw new StreamedImageError('The download archive is encrypted.');
  if (!/\.img$/i.test(name)) throw new StreamedImageError('The download archive does not start with a disk image (.img).');

  // sizes and CRC in the header itself (not deferred to a data descriptor)
  const known: ZipTrailer | undefined =
    flags & 0x8 || headerSize === 0xffffffff ? undefined : { size: headerSize, crc32: fixed.readUInt32LE(14) };

  if (method === 0) {
    // stored: only possible when the size is in the header
    if (flags & 0x8) throw new StreamedImageError('The download archive uses an unsupported layout.');
    if (compressedSize === 0xffffffff) {
      for (let i = 0; i + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(i);
        const length = extra.readUInt16LE(i + 2);
        if (id === 1 && length >= 16) compressedSize = Number(extra.readBigUInt64LE(i + 4 + 8));
        i += 4 + length;
      }
    }
    return {
      name,
      trailer: Promise.resolve(known),
      data: (async function* () {
        let left = compressedSize;
        for await (const chunk of reader.rest()) {
          if (chunk.length >= left) {
            yield chunk.subarray(0, left);
            await reader.close();
            return;
          }
          left -= chunk.length;
          yield chunk;
        }
      })(),
    };
  }
  if (method !== 8) throw new StreamedImageError(`The download archive uses an unsupported compression (${method}).`);

  let settle!: (value: ZipTrailer | undefined) => void;
  const trailer = new Promise<ZipTrailer | undefined>((resolve) => {
    settle = resolve;
  });

  return {
    name,
    trailer,
    data: (async function* () {
      const inflate = createInflateRaw();
      let inflateEnded = false;
      inflate.on('end', () => {
        inflateEnded = true;
      });
      // the last few chunks fed to the inflater, to find the bytes that follow the compressed data
      const recent: Array<{ start: number; chunk: Buffer }> = [];
      const after: Buffer[] = [];
      let afterBytes = 0;
      let fed = 0;
      const pump = (async () => {
        for await (const chunk of reader.rest()) {
          if (inflateEnded || inflate.destroyed) {
            if (afterBytes >= MAX_TRAILER_BYTES) break;
            after.push(chunk); // data descriptor and central directory
            afterBytes += chunk.length;
            continue;
          }
          recent.push({ start: fed, chunk });
          fed += chunk.length;
          if (recent.length > 8) recent.shift();
          if (!inflate.write(chunk)) {
            // "close" as well: a destroyed stream never drains, and waiting for it would hang the cleanup.
            // Whichever comes first removes the other listener, so none pile up over a multi-gigabyte image.
            await new Promise<void>((resolve) => {
              const done = () => {
                inflate.off('drain', done);
                inflate.off('close', done);
                resolve();
              };
              inflate.once('drain', done);
              inflate.once('close', done);
            });
          }
        }
        if (!inflateEnded && !inflate.destroyed) inflate.end();
      })().catch((error) => inflate.destroy(error instanceof Error ? error : new Error(String(error))));

      let completed = false;
      try {
        for await (const chunk of inflate) yield chunk as Buffer;
        completed = true;
      } finally {
        if (!completed) {
          inflate.destroy();
          await reader.close().catch(() => undefined);
          settle(undefined);
        }
        await pump.catch(() => undefined);
      }
      // the compressed data ended: whatever follows it holds the checksum
      const consumed = inflate.bytesWritten;
      const following = recent
        .filter((entry) => entry.start + entry.chunk.length > consumed)
        .map((entry) => (entry.start >= consumed ? entry.chunk : entry.chunk.subarray(consumed - entry.start)));
      settle(known ?? parseDataDescriptor(Buffer.concat([...following, ...after])));
      inflate.destroy();
      await reader.close().catch(() => undefined);
    })(),
  };
};

export interface ConfiguredImageOptions {
  /** Where the temporary boot-partition file is made (default: the system temp folder). */
  tmpDir?: string;
  maxHeadBytes?: number;
  /** Resume position of this download: it may not fall inside the boot partition (see withConfigInBootPartition). */
  skip?: number;
}

/**
 * Reads the start of a disk image, up to the end of its first (boot) partition, into `headPath`. Returns where that
 * partition ends and the bytes of the chunk that crossed the boundary (they belong to the rest of the image).
 */
const captureHead = async (
  iterator: AsyncIterator<Buffer>,
  headPath: string,
  limit: number,
): Promise<{ headEnd: number; leftover: Buffer }> => {
  let leftover: Buffer = Buffer.alloc(0);
  const file = await open(headPath, 'w+');
  let written = 0;
  let known = Buffer.alloc(0); // first sectors, to read the partition table
  let headEnd: number | undefined;
  try {
    while (headEnd === undefined || written < headEnd) {
      const next = await iterator.next();
      if (next.done) throw new StreamedImageError('The image ended before its boot partition did.');
      let chunk = next.value;
      if (headEnd === undefined && known.length < 64 * 1024) {
        known = Buffer.concat([known, chunk.subarray(0, 64 * 1024 - known.length)]);
        const result = firstPartitionEnd(known);
        if ('end' in result) {
          if (result.end > limit) throw new StreamedImageError('The first partition of this image is unexpectedly large.');
          headEnd = result.end;
        } else if (known.length >= 64 * 1024) {
          throw new StreamedImageError('The disk image partition table is not readable.');
        }
      }
      if (headEnd !== undefined && written + chunk.length > headEnd) {
        leftover = chunk.subarray(headEnd - written);
        chunk = chunk.subarray(0, headEnd - written);
      }
      try {
        await file.write(chunk, 0, chunk.length, written);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
          throw new StreamedImageError('The server has no temporary disk space left to prepare the image.', 507);
        }
        throw error;
      }
      written += chunk.length;
      if (written > limit) throw new StreamedImageError('The first partition of this image is unexpectedly large.');
    }
  } finally {
    await file.close();
  }
  return { headEnd: headEnd as number, leftover };
};

/** Writes `config` into the boot partition of the head file and proves it is there, without changing the size. */
const writeAndCheckConfig = async (headPath: string, headEnd: number, config: Record<string, unknown>): Promise<void> => {
  await writeConfigToImage(headPath, config);
  if ((await stat(headPath)).size !== headEnd) {
    throw new StreamedImageError('Writing the configuration changed the image size.', 500);
  }
  const check = await readConfigFromImage(headPath);
  if (JSON.stringify(check) !== JSON.stringify(config)) {
    throw new StreamedImageError('The configuration could not be written into the image.', 500);
  }
};

/**
 * Takes the raw disk image bytes and yields the same image with `config` written into its boot partition.
 * The first chunk is produced only after the boot partition has been patched (so a failure there happens before any
 * byte is sent).
 */
export async function* withConfigInBootPartition(
  image: AsyncIterable<Buffer>,
  config: Record<string, unknown>,
  options: ConfiguredImageOptions = {},
): AsyncGenerator<Buffer> {
  const iterator = image[Symbol.asyncIterator]();
  const dir = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), 'vector-image-'));
  const headPath = path.join(dir, 'head.img');
  try {
    const { headEnd, leftover } = await captureHead(iterator, headPath, options.maxHeadBytes ?? MAX_HEAD_BYTES);
    // Writing config.json stamps the file with the time, so the boot partition differs by a few bytes from one run to
    // the next. Stitching two runs together inside it would give a file no run ever produced; after it, the bytes are
    // the image exactly as published and any run gives the same.
    if (options.skip && options.skip > 0 && options.skip < headEnd) {
      throw new StreamedImageError('This download can only be resumed from a later point. Start it again from the beginning.', 409);
    }
    await writeAndCheckConfig(headPath, headEnd, config);

    for await (const chunk of createReadStream(headPath, { highWaterMark: 1024 * 1024 })) yield chunk as Buffer;
    await rm(dir, { recursive: true, force: true }); // the boot partition is gone from disk before the long tail starts
    if (leftover.length) yield leftover;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Drops the first `count` bytes of a stream: how a download resumes where an interrupted one stopped. */
export async function* skipBytes(source: AsyncIterable<Buffer>, count: number): AsyncGenerator<Buffer> {
  let left = count;
  for await (const chunk of source) {
    if (left <= 0) {
      yield chunk;
    } else if (chunk.length <= left) {
      left -= chunk.length;
    } else {
      yield chunk.subarray(left);
      left = 0;
    }
  }
  if (left > 0) throw new StreamedImageError('The image is shorter than the point the download should resume from.', 416);
}

export interface BootPatch {
  /** Where the boot partition ends: the patches all lie before this offset. */
  bootEnd: number;
  /** SHA-256 of the image's first `bootEnd` bytes as balena publishes them, so a local copy can be matched to it. */
  headSha256: string;
  /** The blocks that differ once config.json is in, to be written over a copy of the same image. */
  patches: Array<{ offset: number; data: Buffer }>;
}

const PATCH_BLOCK = 4096;
const MAX_PATCH_BYTES = 16 * 1024 * 1024;

const sha256OfFile = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

/** Contiguous runs of blocks that differ between two files of equal length. */
const diffFiles = async (originalPath: string, patchedPath: string, size: number): Promise<BootPatch['patches']> => {
  const [original, patched] = await Promise.all([open(originalPath, 'r'), open(patchedPath, 'r')]);
  const patches: BootPatch['patches'] = [];
  let total = 0;
  try {
    const a = Buffer.alloc(PATCH_BLOCK);
    const b = Buffer.alloc(PATCH_BLOCK);
    let current: { offset: number; parts: Buffer[] } | undefined;
    const flush = () => {
      if (!current) return;
      const data = Buffer.concat(current.parts);
      total += data.length;
      if (total > MAX_PATCH_BYTES) throw new StreamedImageError('Writing the configuration changed far more of the image than expected.', 500);
      patches.push({ offset: current.offset, data });
      current = undefined;
    };
    for (let offset = 0; offset < size; offset += PATCH_BLOCK) {
      const length = Math.min(PATCH_BLOCK, size - offset);
      await Promise.all([original.read(a, 0, length, offset), patched.read(b, 0, length, offset)]);
      if (a.compare(b, 0, length, 0, length) !== 0) {
        const block = Buffer.from(b.subarray(0, length));
        if (current && current.offset + current.parts.reduce((n, part) => n + part.length, 0) === offset) current.parts.push(block);
        else {
          flush();
          current = { offset, parts: [block] };
        }
      } else {
        flush();
      }
    }
    flush();
  } finally {
    await Promise.all([original.close(), patched.close()]);
  }
  return patches;
};

/**
 * What it takes to turn a local copy of the base image into a flash-ready one: the few blocks of the boot partition
 * that change when config.json is written. Only the start of the image is read; the rest is never downloaded.
 */
export const bootPatchFromImage = async (
  image: AsyncIterable<Buffer>,
  config: Record<string, unknown>,
  options: ConfiguredImageOptions = {},
): Promise<BootPatch> => {
  const iterator = image[Symbol.asyncIterator]();
  const dir = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), 'vector-patch-'));
  const originalPath = path.join(dir, 'original.img');
  const patchedPath = path.join(dir, 'patched.img');
  try {
    const { headEnd } = await captureHead(iterator, originalPath, options.maxHeadBytes ?? MAX_HEAD_BYTES);
    await copyFile(originalPath, patchedPath);
    await writeAndCheckConfig(patchedPath, headEnd, config);
    return { bootEnd: headEnd, headSha256: await sha256OfFile(originalPath), patches: await diffFiles(originalPath, patchedPath, headEnd) };
  } finally {
    await iterator.return?.().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
};

export interface ZipEntryInfo {
  name: string;
  /** Size of the disk image once unzipped. */
  size: number;
  crc32: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL_HEADER = 0x02014b50;

/**
 * Reads the first entry's exact size and CRC-32 from the zip's central directory, which sits at the end of the file,
 * with one small range request. Returns undefined when the service cannot answer range requests or the directory is
 * not where expected: the image can still be streamed, just without the up-front size and the end-to-end check.
 */
export const readZipEntryInfo = async (
  url: string,
  totalSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ZipEntryInfo | undefined> => {
  try {
    const tailLength = Math.min(totalSize, 256 * 1024);
    const tailStart = totalSize - tailLength;
    const response = await fetchImpl(url, { headers: { range: `bytes=${tailStart}-${totalSize - 1}` } });
    if (!(response.status === 206 || (response.status === 200 && tailStart === 0))) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const tail = Buffer.from(await response.arrayBuffer());
    if (tail.length !== tailLength) return undefined;

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return undefined;
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff && eocd >= 20 && tail.readUInt32LE(eocd - 20) === EOCD64_LOCATOR) {
      const eocd64 = Number(tail.readBigUInt64LE(eocd - 20 + 8)) - tailStart;
      if (eocd64 < 0 || tail.readUInt32LE(eocd64) !== EOCD64) return undefined;
      directoryOffset = Number(tail.readBigUInt64LE(eocd64 + 48));
    }
    const at = directoryOffset - tailStart;
    if (at < 0 || at + 46 > tail.length || tail.readUInt32LE(at) !== CENTRAL_HEADER) return undefined;

    const crc = tail.readUInt32LE(at + 16);
    let size = tail.readUInt32LE(at + 24);
    const nameLength = tail.readUInt16LE(at + 28);
    const extraLength = tail.readUInt16LE(at + 30);
    const name = tail.toString('utf8', at + 46, at + 46 + nameLength);
    if (size === 0xffffffff) {
      const extra = tail.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      for (let i = 0; i + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(i);
        const length = extra.readUInt16LE(i + 2);
        if (id === 1 && length >= 8) size = Number(extra.readBigUInt64LE(i + 4));
        i += 4 + length;
      }
      if (size === 0xffffffff) return undefined;
    }
    return { name, size, crc32: crc };
  } catch {
    return undefined;
  }
};

/**
 * Passes the image through while checking it against the zip's own size and CRC-32. The last megabyte is held back
 * until the check has passed, so a corrupt or cut-short download ends with an error before the final bytes are sent
 * and the browser never sees a complete-looking file.
 */
export async function* verifiedImage(
  source: AsyncIterable<Buffer>,
  expected: ZipTrailer | (() => Promise<ZipTrailer | undefined>),
  holdBack = 1024 * 1024,
  onResult?: (checked: boolean) => void,
): AsyncGenerator<Buffer> {
  let crc = 0;
  let seen = 0;
  const queue: Buffer[] = [];
  let queued = 0;
  for await (const chunk of source) {
    crc = crc32(chunk, crc);
    seen += chunk.length;
    queue.push(chunk);
    queued += chunk.length;
    while (queue.length > 1 && queued - queue[0].length >= holdBack) {
      const out = queue.shift()!;
      queued -= out.length;
      yield out;
    }
  }
  const wanted = typeof expected === 'function' ? await expected() : expected;
  if (!wanted) {
    onResult?.(false); // the archive records nothing to check against; a complete deflate stream is all there is
    yield* queue;
    return;
  }
  if (seen !== wanted.size) {
    throw new StreamedImageError(`The download ended early (${seen} of ${wanted.size} bytes).`);
  }
  if (crc >>> 0 !== wanted.crc32 >>> 0) {
    throw new StreamedImageError('The image failed its integrity check, so it was not delivered. Try again.');
  }
  onResult?.(true);
  yield* queue;
}

/** Fails a source that sends nothing for `ms`, so a stalled download does not hold a connection forever. */
export async function* withStallTimeout(source: AsyncIterable<Buffer>, ms: number): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamedImageError('The balenaOS download stalled. Try again.')), ms);
        }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

/**
 * Whether balena's download service offers this image. The release catalog also lists versions that have no image
 * download (some newer releases), so this is asked before anything is registered or offered. Reads one byte.
 */
export const isDownloadable = async (url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> => {
  try {
    const response = await fetchImpl(url, { headers: { range: 'bytes=0-0' } });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
};

export interface OpenImageOptions extends ConfiguredImageOptions {
  fetchImpl?: typeof fetch;
  /** How long balena may take to start answering (default 30 s). */
  connectTimeoutMs?: number;
  /** How long the download may go without a single byte before it is given up (default 60 s). */
  stallTimeoutMs?: number;
  /** Resume: start sending at this byte of the image (the earlier bytes are read and dropped). */
  skip?: number;
}

export interface OpenedImage {
  stream: Readable;
  fileName: string;
  /** Exact size of the image that will be sent, when it is known before the download starts. */
  size?: number;
  /** Settles when the stream ends: true if the data matched the archive's recorded size and CRC-32. */
  verification: Promise<boolean>;
}

interface OpenedEntry {
  entry: Awaited<ReturnType<typeof zipFirstEntry>>;
  info: ZipEntryInfo | undefined;
  controller: AbortController;
}

/** Starts the balena download and reads the zip header. Closing `controller` stops the download. */
const openZipEntry = async (url: string, options: OpenImageOptions): Promise<OpenedEntry> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), options.connectTimeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch {
    controller.abort();
    throw new StreamedImageError('The balenaOS download service could not be reached.');
  } finally {
    clearTimeout(connectTimer);
  }
  if (!response.ok || !response.body) {
    controller.abort();
    throw new StreamedImageError(
      `The balenaOS download service answered HTTP ${response.status}. Check that this device type and version exist.`,
      response.status === 404 ? 404 : 502,
    );
  }
  try {
    const zipSize = Number(response.headers.get('content-length'));
    const info = Number.isFinite(zipSize) && zipSize > 0 ? await readZipEntryInfo(url, zipSize, fetchImpl) : undefined;
    const source = withStallTimeout(Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>, options.stallTimeoutMs ?? 60_000);
    return { entry: await zipFirstEntry(source), info, controller };
  } catch (error) {
    controller.abort();
    throw error;
  }
};

/**
 * Starts downloading `url` (a balenaOS zip) and returns a stream of the disk image: with `config` written into its
 * boot partition, or as it is when `config` is undefined. Resolves once the first bytes are ready (the boot
 * partition has been patched), so callers can still answer with an error status if anything went wrong.
 * Closing the returned stream also stops the download from balena.
 */
const openImage = async (url: string, config: Record<string, unknown> | undefined, options: OpenImageOptions): Promise<OpenedImage> => {
  const { entry, info, controller } = await openZipEntry(url, options);
  try {
    let reportVerification!: (checked: boolean) => void;
    const verification = new Promise<boolean>((resolve) => {
      reportVerification = resolve;
    });
    verification.catch(() => undefined);
    const checked = verifiedImage(entry.data, info ?? (() => entry.trailer), undefined, reportVerification);
    let generator: AsyncGenerator<Buffer> = config ? withConfigInBootPartition(checked, config, options) : checked;
    if (options.skip && options.skip > 0) generator = skipBytes(generator, options.skip);
    const first = await generator.next();
    if (first.done) throw new StreamedImageError('The download was empty.');
    const stream = Readable.from(
      (async function* () {
        try {
          yield first.value;
          yield* generator;
        } finally {
          // also when the client leaves right after the first chunk: closes the download and removes the temp files
          await generator.return(undefined);
          controller.abort();
        }
      })(),
      { objectMode: false },
    );
    stream.once('close', () => reportVerification(false)); // no-op when the check already settled it
    return { stream, fileName: path.basename(entry.name), size: info ? info.size : undefined, verification };
  } catch (error) {
    controller.abort();
    throw error;
  }
};

/** The balenaOS image with `config` written into its boot partition. */
export const openConfiguredImage = (url: string, config: Record<string, unknown>, options: OpenImageOptions = {}): Promise<OpenedImage> =>
  openImage(url, config, options);

/** The balenaOS image exactly as balena publishes it (verified against its checksum), to keep as a local base image. */
export const openBaseImage = (url: string, options: OpenImageOptions = {}): Promise<OpenedImage> => openImage(url, undefined, options);

/**
 * The few blocks that make a local copy of the base image flash-ready. Reads only the start of balena's download
 * (a few megabytes compressed) and stops it.
 */
export const openBootPatch = async (
  url: string,
  config: Record<string, unknown>,
  options: OpenImageOptions = {},
): Promise<BootPatch & { fileName: string }> => {
  const { entry, controller } = await openZipEntry(url, options);
  try {
    const patch = await bootPatchFromImage(entry.data, config, options);
    return { ...patch, fileName: path.basename(entry.name) };
  } finally {
    controller.abort();
  }
};
