import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateRawSync, gunzipSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { readConfigFromImage } from './configuredImage';
import {
  firstPartitionEnd,
  openConfiguredImage,
  parseDataDescriptor,
  readZipEntryInfo,
  StreamedImageError,
  verifiedImage,
  withStallTimeout,
  zipFirstEntry,
} from './streamedImage';

let tmp: string;
let disk: Buffer;

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'vector-streamed-'));
  const boot = gunzipSync(await readFile(path.join(__dirname, 'fixtures', 'tiny.img.gz')));
  // the fixture's only partition fills the disk: append bytes after it, standing in for the root filesystem partitions
  const rest = randomBytes(3 * 1024 * 1024 + 123); // incompressible, like real filesystem partitions
  disk = Buffer.concat([boot, rest]);
});
after(() => rm(tmp, { recursive: true, force: true }));

const u32 = (value: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
};
const u16 = (value: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
};

/** A zip with one entry, written the way streaming zippers do: sizes after the data (data descriptor). */
const makeZip = (name: string, data: Buffer, options: { method?: 0 | 8; descriptor?: boolean; directory?: boolean } = {}): Buffer => {
  const method = options.method ?? 8;
  const descriptor = options.descriptor ?? method === 8;
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name);
  const checksum = crc32(data);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(descriptor ? 0x8 : 0),
    u16(method),
    u16(0),
    u16(0),
    u32(descriptor ? 0 : checksum),
    u32(descriptor ? 0 : body.length),
    u32(descriptor ? 0 : data.length),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
  ]);
  const tail = descriptor ? Buffer.concat([u32(0x08074b50), u32(checksum), u32(body.length), u32(data.length)]) : Buffer.alloc(0);
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(descriptor ? 0x8 : 0), u16(method), u16(0), u16(0),
    u32(checksum), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0),
    nameBytes,
  ]);
  const cdOffset = local.length + body.length + tail.length;
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(cdOffset), u16(0)]);
  const directory = options.directory === false ? Buffer.alloc(60, 7) : Buffer.concat([central, end]);
  return Buffer.concat([local, body, tail, directory]);
};

/** A response that delivers a buffer in small chunks, like a network would. */
const asResponse = (zip: Buffer, status = 200, chunk = 64 * 1024, extra: Record<string, string> = {}): Response => {
  async function* chunks() {
    for (let i = 0; i < zip.length; i += chunk) yield zip.subarray(i, i + chunk);
  }
  return new Response(status === 200 || status === 206 ? (Readable.toWeb(Readable.from(chunks())) as never) : 'no', {
    status,
    headers: status === 200 ? { 'content-length': String(zip.length), ...extra } : extra,
  });
};

/** Pretends to be balena's download service: whole file for a plain request, the asked bytes for a Range request. */
const balena =
  (zip: Buffer, options: { ranges?: boolean; chunk?: number } = {}): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    if (!range) return asResponse(zip, 200, options.chunk);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    if (options.ranges === false) return asResponse(zip, 200);
    return new Response(zip.subarray(Number(match[1]), Number(match[2]) + 1) as never, { status: 206 });
  }) as unknown as typeof fetch;

const collect = async (stream: AsyncIterable<Buffer>): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
};

const bootEnd = (): number => {
  const result = firstPartitionEnd(disk);
  if (!('end' in result)) throw new Error('fixture has no partition table');
  return result.end;
};

describe('firstPartitionEnd', () => {
  it('reads the first MBR partition', () => {
    const end = bootEnd();
    assert.ok(end > 0 && end < disk.length, `end ${end}`);
  });

  it('asks for more bytes until it can decide', () => {
    assert.deepEqual(firstPartitionEnd(disk.subarray(0, 100)), { needBytes: 512 });
  });

  it('reads a GPT first partition', () => {
    const gpt = Buffer.alloc(34 * 512);
    gpt.writeUInt16LE(0xaa55, 510);
    gpt[446 + 4] = 0xee;
    gpt.write('EFI PART', 512, 'ascii');
    gpt.writeBigUInt64LE(2n, 512 + 72);
    gpt.writeUInt32LE(128, 512 + 80);
    gpt.writeUInt32LE(128, 512 + 84);
    gpt.writeBigUInt64LE(2048n, 1024 + 32);
    gpt.writeBigUInt64LE(133119n, 1024 + 40);
    assert.deepEqual(firstPartitionEnd(gpt), { end: 133120 * 512 });
    assert.deepEqual(firstPartitionEnd(gpt.subarray(0, 700)), { needBytes: 1024 });
  });

  it('rejects data that is not a disk', () => {
    assert.throws(() => firstPartitionEnd(Buffer.alloc(512)), StreamedImageError);
  });
});

describe('zipFirstEntry', () => {
  it('inflates an entry whose size is only known after the data, ignoring what follows', async () => {
    const zip = makeZip('balena.img', disk);
    const entry = await zipFirstEntry(Readable.from(asChunks(zip, 1000)));
    assert.equal(entry.name, 'balena.img');
    assert.ok((await collect(entry.data)).equals(disk));
  });

  it('copies a stored entry of known size', async () => {
    const zip = makeZip('plain.img', disk.subarray(0, 4096), { method: 0, descriptor: false });
    const entry = await zipFirstEntry(Readable.from(asChunks(zip, 700)));
    assert.ok((await collect(entry.data)).equals(disk.subarray(0, 4096)));
  });

  it('rejects other content', async () => {
    await assert.rejects(zipFirstEntry(Readable.from([Buffer.from('<html>not a zip, long enough to read a header</html>')])), /not a zip/);
    await assert.rejects(zipFirstEntry(Readable.from(asChunks(makeZip('readme.txt', Buffer.from('hi')), 100))), /\.img/);
  });
});

function asChunks(buffer: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buffer.length; i += size) out.push(buffer.subarray(i, i + size));
  return out;
}

describe('openConfiguredImage', () => {
  const config = { applicationId: 7, apiEndpoint: 'https://api.example.test', balenaRootCA: 'x'.repeat(6000), uuid: 'abc' };
  const fetchOf = (zip: Buffer) => balena(zip);

  it('sends the whole image with config.json written in and the rest untouched, leaving nothing on disk', async () => {
    const scratch = await mkdtemp(path.join(tmp, 'a-'));
    const { stream, fileName } = await openConfiguredImage('https://download.test/x.zip', config, {
      fetchImpl: fetchOf(makeZip('balena-test.img', disk)),
      tmpDir: scratch,
    });
    assert.equal(fileName, 'balena-test.img');
    const image = await collect(stream);

    assert.equal(image.length, disk.length, 'same size as the original image');
    const end = bootEnd();
    assert.ok(image.subarray(end).equals(disk.subarray(end)), 'everything after the boot partition is unchanged');
    assert.ok(!image.subarray(0, end).equals(disk.subarray(0, end)), 'the boot partition was modified');

    const out = path.join(tmp, 'out.img');
    await writeFile(out, image);
    assert.deepEqual(await readConfigFromImage(out), config);
    assert.deepEqual(await readdir(scratch), [], 'no temporary files are left');
  });

  it('cleans up when the client goes away halfway', async () => {
    const scratch = await mkdtemp(path.join(tmp, 'b-'));
    const { stream } = await openConfiguredImage('https://download.test/x.zip', config, {
      fetchImpl: fetchOf(makeZip('balena-test.img', disk)),
      tmpDir: scratch,
    });
    for await (const chunk of stream) {
      assert.ok(chunk.length > 0);
      break; // the read loop ending closes the stream, as a disconnect does
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await readdir(scratch), []);
  });

  it('fails before sending anything when the download is unusable', async () => {
    await assert.rejects(
      openConfiguredImage('https://download.test/x.zip', config, { fetchImpl: (async () => asResponse(Buffer.alloc(0), 404)) as unknown as typeof fetch }),
      /HTTP 404/,
    );
    await assert.rejects(
      openConfiguredImage('https://download.test/x.zip', config, { fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch }),
      /could not be reached/,
    );
    await assert.rejects(
      openConfiguredImage('https://download.test/x.zip', config, { fetchImpl: fetchOf(makeZip('balena.img', Buffer.alloc(4096, 1))) }),
      /partition table/,
    );
  });

  it('fails when the image ends before its boot partition does', async () => {
    await assert.rejects(
      openConfiguredImage('https://download.test/x.zip', config, { fetchImpl: fetchOf(makeZip('balena.img', disk.subarray(0, 1024 * 1024))) }),
      /ended before/,
    );
  });
});

describe('readZipEntryInfo', () => {
  it('reads the exact size and CRC-32 of the image from the end of the zip', async () => {
    const zip = makeZip('balena.img', disk);
    const info = await readZipEntryInfo('https://download.test/x.zip', zip.length, balena(zip));
    assert.deepEqual(info, { name: 'balena.img', size: disk.length, crc32: crc32(disk) >>> 0 });
  });

  it('returns nothing when the service cannot do range requests or the zip has no directory', async () => {
    const noise = randomBytes(700_000); // incompressible, so the archive is larger than the 256 KB tail that is read
    const zip = makeZip('balena.img', noise);
    assert.ok(zip.length > 300_000);
    assert.equal(await readZipEntryInfo('https://download.test/x.zip', zip.length, balena(zip, { ranges: false })), undefined);
    const bare = makeZip('balena.img', noise, { directory: false });
    assert.equal(await readZipEntryInfo('https://download.test/x.zip', bare.length, balena(bare)), undefined);
  });
});

describe('verifiedImage', () => {
  const source = (parts: Buffer[]) => Readable.from(parts) as AsyncIterable<Buffer>;
  const pieces = () => asChunks(disk, 100_000);

  it('passes a good image through unchanged', async () => {
    const out = await collect(verifiedImage(source(pieces()), { size: disk.length, crc32: crc32(disk) >>> 0 }, 256 * 1024));
    assert.ok(out.equals(disk));
  });

  it('withholds the end until the check has passed, then fails on a wrong checksum', async () => {
    const delivered: Buffer[] = [];
    await assert.rejects(async () => {
      for await (const chunk of verifiedImage(source(pieces()), { size: disk.length, crc32: 123 }, 256 * 1024)) delivered.push(chunk);
    }, /integrity/);
    const sent = Buffer.concat(delivered).length;
    assert.ok(sent <= disk.length - 256 * 1024, `the last 256 KB must not be sent (sent ${sent} of ${disk.length})`);
  });

  it('fails when the image is shorter than the zip says', async () => {
    await assert.rejects(
      collect(verifiedImage(source(asChunks(disk.subarray(0, disk.length - 10), 100_000)), { size: disk.length, crc32: crc32(disk) >>> 0 }, 1024)),
      /ended early/,
    );
  });
});

describe('withStallTimeout', () => {
  it('gives up on a source that goes quiet, and passes a lively one', async () => {
    async function* quiet() {
      yield Buffer.from('a');
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield Buffer.from('b');
    }
    await assert.rejects(collect(withStallTimeout(quiet(), 50)), /stalled/);
    assert.equal((await collect(withStallTimeout(Readable.from([Buffer.from('x'), Buffer.from('y')]) as AsyncIterable<Buffer>, 1000))).toString(), 'xy');
  });
});

describe('openConfiguredImage integrity', () => {
  const config = { applicationId: 7, uuid: 'abc' };

  it('announces the exact size and reports that the image is verified', async () => {
    const opened = await openConfiguredImage('https://download.test/x.zip', config, { fetchImpl: balena(makeZip('balena.img', disk)), tmpDir: tmp });
    assert.equal(opened.size, disk.length);
    assert.equal((await collect(opened.stream)).length, disk.length);
    assert.equal(await opened.verification, true);
  });

  it('checks the image at the end, from the data descriptor in the archive, when the service cannot answer range requests', async () => {
    const opened = await openConfiguredImage('https://download.test/x.zip', config, {
      fetchImpl: balena(makeZip('balena.img', disk), { ranges: false }),
      tmpDir: tmp,
    });
    assert.equal(opened.size, undefined, 'the size is not known up front');
    assert.equal((await collect(opened.stream)).length, disk.length);
    assert.equal(await opened.verification, true);
  });

  it('refuses a corrupted image even when only the data descriptor can vouch for it', async () => {
    const zip = makeZip('balena.img', disk);
    // the descriptor sits right after the compressed data: signature, then the CRC-32
    const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    assert.ok(at > 0);
    zip.writeUInt32LE(0xdeadbeef, at + 4);
    const opened = await openConfiguredImage('https://download.test/x.zip', config, {
      fetchImpl: balena(zip, { ranges: false }),
      tmpDir: tmp,
    });
    let received = 0;
    await assert.rejects(async () => {
      for await (const chunk of opened.stream) received += (chunk as Buffer).length;
    }, /integrity/);
    assert.ok(received < disk.length, 'the final bytes were held back');
  });

  it('still delivers an image whose archive records nothing to check against', async () => {
    const opened = await openConfiguredImage('https://download.test/x.zip', config, {
      fetchImpl: balena(makeZip('balena.img', disk, { directory: false }), { ranges: false }),
      tmpDir: tmp,
    });
    assert.equal((await collect(opened.stream)).length, disk.length);
    assert.equal(await opened.verification, false, 'reported as not checked');
  });

  it('refuses to deliver the end of an image that does not match its checksum', async () => {
    const zip = makeZip('balena.img', disk);
    // corrupt the stored checksum in the central directory, as a damaged or tampered archive would
    const at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0xdeadbeef, at + 16);
    const opened = await openConfiguredImage('https://download.test/x.zip', config, { fetchImpl: balena(zip), tmpDir: tmp });
    let received = 0;
    await assert.rejects(async () => {
      for await (const chunk of opened.stream) received += (chunk as Buffer).length;
    }, /integrity/);
    assert.ok(received < disk.length, 'the final bytes were held back');
  });

  it('fails cleanly when the archive is cut off in the middle', async () => {
    const zip = makeZip('balena.img', disk);
    const cut = zip.subarray(0, Math.floor(zip.length / 2));
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      if ((init?.headers as Record<string, string> | undefined)?.range) return new Response('', { status: 416 });
      return asResponse(cut);
    }) as unknown as typeof fetch;
    const scratch = await mkdtemp(path.join(tmp, 'c-'));
    const attempt = openConfiguredImage('https://download.test/x.zip', config, { fetchImpl, tmpDir: scratch }).then((opened) => collect(opened.stream));
    await assert.rejects(attempt);
    assert.deepEqual(await readdir(scratch), [], 'no temporary files are left');
  });
});

describe('data descriptor', () => {
  const crc = 0xcafebabe;
  const central = u32(0x02014b50);

  it('is found with or without the signature, with 32 or 64 bit sizes', () => {
    const sig = u32(0x08074b50);
    const plain = Buffer.concat([u32(crc), u32(100), u32(300), central, Buffer.alloc(8)]);
    assert.deepEqual(parseDataDescriptor(Buffer.concat([sig, plain])), { crc32: crc, size: 300 });
    assert.deepEqual(parseDataDescriptor(plain), { crc32: crc, size: 300 });
    const wide = Buffer.alloc(16);
    wide.writeBigUInt64LE(5_000_000_000n, 0);
    wide.writeBigUInt64LE(9_000_000_000n, 8);
    assert.deepEqual(parseDataDescriptor(Buffer.concat([sig, u32(crc), wide, central, Buffer.alloc(8)])), { crc32: crc, size: 9_000_000_000 });
  });

  it('is not guessed when nothing follows it or the bytes are junk', () => {
    assert.equal(parseDataDescriptor(Buffer.alloc(0)), undefined);
    assert.equal(parseDataDescriptor(Buffer.concat([u32(0x08074b50), u32(crc), u32(1), u32(2)])), undefined);
    assert.equal(parseDataDescriptor(Buffer.alloc(60, 7)), undefined);
  });

  it('is reported by zipFirstEntry once the data has been read, from whatever chunks it arrives in', async () => {
    for (const size of [37, 1000, 64 * 1024]) {
      const zip = makeZip('balena.img', disk);
      const entry = await zipFirstEntry(Readable.from(asChunks(zip, size)));
      assert.ok((await collect(entry.data)).equals(disk));
      assert.deepEqual(await entry.trailer, { size: disk.length, crc32: crc32(disk) >>> 0 }, `chunk size ${size}`);
    }
  });

  it('is taken from the header when the archive stores sizes there', async () => {
    const zip = makeZip('plain.img', disk.subarray(0, 4096), { method: 0, descriptor: false });
    const entry = await zipFirstEntry(Readable.from(asChunks(zip, 700)));
    await collect(entry.data);
    assert.deepEqual(await entry.trailer, { size: 4096, crc32: crc32(disk.subarray(0, 4096)) >>> 0 });
  });
});
