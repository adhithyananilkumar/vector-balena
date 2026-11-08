import express from 'express';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';
import dockerDelta = require('docker-delta');
import Docker = require('dockerode');
import * as dt from 'docker-toolbelt';
import * as jwt from 'jsonwebtoken';

const PORT = 80;
const DEBUG = true;

const deltaRsyncPath = '/delta-rsync';

// Pull environment variables
const balenaTld = String(process.env.BALENA_TLD);
const regHost = String(process.env.REGISTRY_HOST ?? `registry.${balenaTld}`);
const builderToken = String(process.env.TOKEN_AUTH_BUILDER_TOKEN);

// Load public certificate and enable authentication
const alg = (process.env.JWT_ALGO ?? 'ES256') as jwt.Algorithm;
const pubFile = `/certs/private/api.${balenaTld}.pem`;
let pub: Buffer;
let authEnabled = false;
if (fs.existsSync(pubFile)) {
  authEnabled = true;
  pub = fs.readFileSync(pubFile);
}

// Authentication settings for dockerode
const authOpts = {
  authconfig: {
    username: 'builder',
    password: builderToken,
    serveraddress: regHost,
  },
};

// Authentication settings for docker-cli
const authFile = JSON.stringify({
  auths: {
    [regHost]: {
      auth: Buffer.from(`builder:${builderToken}`).toString('base64'),
    },
  },
});

const docker = new Docker();

// Debug healper function
const log = (msg: string) => {
  if (DEBUG) console.log(`[open-balena-delta] ${msg}`);
};

// Heper function to parse query params
const parseQueryParams = (query: any, headers: any) => {
  // src = old image which we are transitioning from
  // dest = new image which we are transitioning to
  log(`Parsing delta params: ${JSON.stringify({ query })}`);
  if (!query.src || !query.dest)
    throw new Error('src and dest url params must be provided');
  const src = String(query.src);
  const dest = String(query.dest);
  // Parse input params
  const token = headers.authorization?.split(' ')?.[1];
  if (!token) throw new Error('authorization header must be provided');
  const wait = query.wait === 'true';
  return { src, dest, token, wait };
};

// Helper function to parse image tags into delta image tag and path
const parseDeltaParams = (src: string, dest: string) => {
  const IMG_REGEX = /^.*?\/v([0-9]+)\/([0-9a-f]+)(@sha256:([0-9a-f]+))?$/;
  const srcMatch = IMG_REGEX.exec(src);
  const destMatch = IMG_REGEX.exec(dest);

  // Validate input params
  if (!srcMatch || !destMatch)
    throw new Error('src and dest url params must be provided');
  const [, srcRegVer, srcImgBase] = srcMatch;
  const [, destRegVer, destImgBase] = destMatch;
  if (srcRegVer !== destRegVer) {
    throw new Error('src and dest image registry versions must match');
  }

  // Generate delta image name and path
  const deltaTag = `delta-${String(srcImgBase).substring(0, 16)}`;
  const deltaBase = `${destImgBase}:${deltaTag}`;
  const deltaFull = `v${destRegVer}/${deltaBase}`;
  const delta = `${regHost}/${deltaFull}`;

  return { deltaBase, deltaFull, delta, srcImgBase: String(srcImgBase), destImgBase: String(destImgBase) };
};

// Helper function to wait for dockerode stream to finish
const waitForStream = async (stream: NodeJS.ReadableStream) => {
  if (DEBUG) stream.pipe(process.stdout);
  return new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (e) => {
      if (e) return reject(e);
      resolve();
    });
  });
};

// Helper function to handle detection of concurrent delta processes
const building = async (buildingFile: string, retryDelay: number) => {
  let buildingNow = fs.existsSync(buildingFile);
  if (buildingNow) {
    let waitTime = 0;
    const waitASec = () => new Promise((resolve) => setTimeout(resolve, 1000));
    while (buildingNow && waitTime < retryDelay) {
      await waitASec();
      waitTime += 1;
      buildingNow = fs.existsSync(buildingFile);
    }
  }
  return buildingNow;
};

// ---- build records (shown in the Vector UI) ----
interface DeltaRecord {
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
const dataDir = process.env.DELTA_DATA_DIR ?? '/data';
const recordsFile = `${dataDir}/records.json`;
let records: DeltaRecord[] = [];
try {
  records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
} catch (e) {
  records = [];
}
records.forEach((r) => {
  if (r.status === 'building') {
    r.status = 'failed';
    r.error = 'The delta server restarted during the build.';
    r.finishedAt = Date.now();
  }
});
const saveRecords = () => {
  try {
    if (records.length > 500) records = records.slice(-500);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(recordsFile, JSON.stringify(records));
  } catch (e) {
    log(`Unable to save records: ${e.message}`);
  }
};
const deviceOf = (token: string): string | undefined => {
  const payload = jwt.decode(token) as { sub?: string } | null;
  return payload && payload.sub ? String(payload.sub) : undefined;
};
// Note a request for a delta; creates the record on first sight.
const noteRequest = (
  init: { srcImage: string; destImage: string; deltaImage: string },
  token: string
): DeltaRecord => {
  const now = Date.now();
  let rec = records.find((r) => r.deltaImage === init.deltaImage);
  if (!rec) {
    rec = {
      id: crypto.randomUUID(),
      ...init,
      status: 'ready',
      firstRequestedAt: now,
      lastRequestedAt: now,
      requests: 0,
      devices: [],
    };
    records.push(rec);
  }
  rec.requests += 1;
  rec.lastRequestedAt = now;
  const device = deviceOf(token);
  if (device && rec.devices.indexOf(device) < 0) rec.devices.push(device);
  saveRecords();
  return rec;
};

// Compressed size of an image in the registry, from its manifest.
const manifestBytes = async (ref: string): Promise<number | undefined> => {
  const tmpWorkdir = `/tmp/${crypto.randomUUID()}`;
  fs.mkdirSync(`${tmpWorkdir}/.docker`, { recursive: true });
  fs.writeFileSync(`${tmpWorkdir}/.docker/config.json`, authFile);
  try {
    const child = spawn('docker', ['manifest', 'inspect', ref], {
      cwd: tmpWorkdir,
      env: { DOCKER_CONFIG: `${tmpWorkdir}/.docker` },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    if ((await once(child, 'close'))?.[0] !== 0) return undefined;
    const manifest = JSON.parse(out);
    const layers = (manifest.layers ?? []) as Array<{ size?: number }>;
    return (
      layers.reduce((sum, l) => sum + (l.size ?? 0), 0) +
      ((manifest.config && manifest.config.size) || 0)
    );
  } catch (e) {
    return undefined;
  } finally {
    fs.rmSync(tmpWorkdir, { recursive: true, force: true });
  }
};

// Helper function to check if image exists in registry using manifest inspect
const deltaExists = async (delta: string) => {
  const tmpWorkdir = `/tmp/${crypto.randomUUID()}`;
  fs.mkdirSync(`${tmpWorkdir}/.docker`, { recursive: true });
  fs.writeFileSync(`${tmpWorkdir}/.docker/config.json`, authFile);
  const inspectStream = spawn('docker', ['manifest', 'inspect', delta], {
    cwd: tmpWorkdir,
    env: {
      DOCKER_CONFIG: `${tmpWorkdir}/.docker`,
    },
  });
  const exists = (await once(inspectStream, 'close'))?.[0] === 0;
  fs.rmSync(tmpWorkdir, { recursive: true });
  return exists;
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.get('/api/v3/delta', async (req, res) => {
    let buildingFile;
    let rec: DeltaRecord | undefined;
    log('V3 delta request received');

    try {
      const { src, dest, token, wait } = parseQueryParams(
        req.query,
        req.headers
      );

      if (authEnabled) {
        jwt.verify(token, pub, { algorithms: [alg] });
      }

      const { deltaBase, delta, srcImgBase, destImgBase } = parseDeltaParams(
        src,
        dest
      );
      rec = noteRequest(
        { srcImage: srcImgBase, destImage: destImgBase, deltaImage: delta },
        token
      );

      buildingFile = `/tmp/${deltaBase}`;

      // Check if someone is building delta image in a parallel process
      if (await building(buildingFile, wait ? 15 * 60 : 45)) {
        if (wait) throw new Error('Delta image failed to build!');
        // send 504 if not waiting for build to complete
        res.sendStatus(504);
        return;
      }

      const success = () => {
        log(`Sending image name in response body: { name: "${delta}"}`);
        res.set('content-type', 'text/plain');
        res.send(JSON.stringify({ name: delta }));
      };

      // Return delta image if it exists
      if (await deltaExists(delta)) {
        success();
      } else {
        // If delta doesn't exist, send 504 (but keep building)
        if (!wait) res.sendStatus(504);

        // Check again if someone started building delta image in a parallel process
        if (!(await building(buildingFile, wait ? 15 * 60 : 0))) {
          // touch building file to indicate that we are currently building delta image
          fs.closeSync(fs.openSync(buildingFile, 'w'));

          const t0 = Date.now();
          rec.status = 'building';
          rec.error = undefined;
          rec.startedAt = t0;
          rec.finishedAt = undefined;
          saveRecords();

          // Continue executing delta process in background
          const srcStream = await docker.pull(src, authOpts);
          const destStream = await docker.pull(dest, authOpts);
          await Promise.all([
            waitForStream(srcStream),
            waitForStream(destStream),
          ]);
          const t1 = Date.now();
          rec.pullMs = t1 - t0;

          // Create delta image
          const deltaStream = await dt.createDelta(docker, {
            src,
            dest,
            t: delta,
          } as dt.CreateDeltaOptions);
          await waitForStream(deltaStream);
          const t2 = Date.now();
          rec.diffMs = t2 - t1;

          // Push delta image
          const pushStream = await docker.getImage(delta).push(authOpts);
          await waitForStream(pushStream);
          const t3 = Date.now();
          rec.pushMs = t3 - t2;

          // Remove delta image to free up storage
          await docker.getImage(delta).remove(authOpts);

          // Consider removing src and dest images

          // Remove building file
          if (fs.existsSync(buildingFile)) fs.rmSync(buildingFile);

          // Sizes as stored in the registry (compressed)
          rec.srcBytes = await manifestBytes(src);
          rec.destBytes = await manifestBytes(dest);
          rec.deltaBytes = await manifestBytes(delta);
          rec.finishedAt = Date.now();
          rec.buildMs = rec.finishedAt - t0;
          rec.status = 'ready';
          saveRecords();

          // If we are waiting, and we got to this point, delta image was built successfully
          if (wait) success();
        } else if (wait) {
          // Parallel build was started, and we waited 15 minutes, so check again if build was successful
          if (await deltaExists(delta)) {
            success();
          } else {
            throw new Error('Delta image failed to build!');
          }
        }
      }
    } catch (err) {
      log(`V3 delta error: ${err.message}`);
      if (rec && rec.status === 'building') {
        rec.status = 'failed';
        rec.error = String(err.message);
        rec.finishedAt = Date.now();
        saveRecords();
      }
      if (!res.headersSent) {
        res.sendStatus(400);
      } else {
        console.log(
          `Build error occurred, but response was already sent: ${JSON.stringify(
            err
          )}`
        );
      }
      // Remove building file
      if (buildingFile && fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
    }
  });

  app.get('/api/v2/delta', async (req, res) => {
    let buildingFile;

    log('V2 delta request received');

    try {
      const { src, dest, token, wait } = parseQueryParams(
        req.query,
        req.headers
      );

      if (authEnabled) {
        jwt.verify(token, pub, { algorithms: [alg] });
      }

      const { deltaBase } = parseDeltaParams(src, dest);

      buildingFile = `/tmp/${deltaBase}`;

      // Check if we are currently building delta image in a parallel process
      if (await building(buildingFile, wait ? 15 * 60 : 45)) {
        if (wait) throw new Error('Delta image failed to build!');
        // send 504 if not waiting for build to complete
        res.sendStatus(504);
        return;
      }

      const success = () => {
        const downloadUrl = `https://${req.hostname}/api/v2/delta/download?delta=${deltaBase}`;
        log(`Sending download url via location header: ${downloadUrl}`);
        // Set status to 300, which informs supervisor that delta is ready
        res.status(300);
        res.set('location', downloadUrl);
      };

      // Return delta image if it exists
      if (fs.existsSync(`${deltaRsyncPath}/${deltaBase}`)) {
        success();
      } else {
        // Send 504, which informs supervisor that delta is in process
        if (!wait) res.sendStatus(504);

        // Make sure someone else didn't start building delta image while we checked for existence
        if (!(await building(buildingFile, wait ? 15 * 60 : 0))) {
          // touch building file to indicate that we are currently building delta image
          fs.closeSync(fs.openSync(buildingFile, 'w'));

          // Continue executing delta process in background
          const srcStream = await docker.pull(src, authOpts);
          const destStream = await docker.pull(dest, authOpts);
          await Promise.all([
            waitForStream(srcStream),
            waitForStream(destStream),
          ]);

          // Create rsync delta file
          const deltaStream = dockerDelta
            .createDelta(src, dest, true, { log: console.log })
            .pipe(fs.createWriteStream(buildingFile));
          await once(deltaStream, 'finish');

          // Copy rsync delta file to rsync path
          fs.cpSync(buildingFile, `${deltaRsyncPath}/${deltaBase}`);

          // Consider removing src and dest images

          // Remove building file
          if (fs.existsSync(buildingFile)) fs.rmSync(buildingFile);

          // If we are waiting, and we got to this point, delta image was built successfully
          if (wait) success();
        } else if (wait) {
          // Parallel build was started, and we waited 15 minutes, so check again if build was successful
          if (fs.existsSync(`${deltaRsyncPath}/${deltaBase}`)) {
            success();
          } else {
            throw new Error('Delta image failed to build!');
          }
        }
      }
    } catch (err) {
      log(`V2 delta error: ${err.message}`);
      res.sendStatus(400);
      // Remove building file
      if (buildingFile && fs.existsSync(buildingFile)) fs.rmSync(buildingFile);
    }
  });

  app.get('/api/v2/delta/download', async (req, res) => {
    try {
      if (!req.query.delta) throw new Error('delta url param must be provided');
      const delta = String(req.query.delta);
      log(`V2 delta download request received for delta: ${delta}`);

      const deltaRsyncFile = `${deltaRsyncPath}/${delta}`;
      if (!fs.existsSync(deltaRsyncFile))
        throw new Error('Requested delta does not exist!');

      // Set content-length header which is required by supervisor
      res.set('content-length', String(fs.statSync(deltaRsyncFile).size));

      // Stream delta file to response
      fs.createReadStream(deltaRsyncFile).pipe(res);
    } catch (err) {
      log(`V2 delta download error: ${err.message}}`);
      res.sendStatus(400);
    }
  });

  // Build records for the Vector UI. Vector authenticates the user, then calls this with a key derived
  // from the stack's JSON web token secret (HMAC-SHA256 of "delta-records"); devices do not have it.
  app.get('/api/records', (req, res) => {
    const expected = process.env.RECORDS_KEY;
    if (!expected) {
      res.sendStatus(503);
      return;
    }
    const given = Buffer.from(String(req.headers['x-delta-records-key'] || ''));
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given as any, want as any)) {
      res.sendStatus(401);
      return;
    }
    res.json({ records: records.slice().reverse() });
  });

  app.listen(listenPort, () => {
    log(`Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
