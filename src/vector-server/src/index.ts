import express from 'express';
import dotenv from 'dotenv';
import { createServer } from 'node:http';
import { createApiRouter } from './routes/api';
import { bootstrapGlobalAdminFromEnvironment } from './bootstrapGlobalAdmin';
import { createCors, parseAllowedOrigins } from './middleware/cors';
import { createRemoteAccessBackend, type RemoteAccessBackend } from './remoteAccess';
import { attachUnavailableRemoteUpgrade } from './remoteAccess/unavailable';
import { createTrustedProxyPolicy } from './remoteAccess/clientAddress';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Origins of the separately hosted Vector UI. They may call this API and open remote-access sockets.
const allowedOrigins = parseAllowedOrigins(process.env.VECTOR_ALLOWED_ORIGINS);
if (allowedOrigins.length > 0 && !process.env.OPEN_BALENA_REMOTE_ALLOWED_ORIGINS) {
  process.env.OPEN_BALENA_REMOTE_ALLOWED_ORIGINS = allowedOrigins.join(',');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', createTrustedProxyPolicy(process.env.OPEN_BALENA_REMOTE_TRUSTED_PROXIES));
app.use(createCors(allowedOrigins));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
let remoteAccess: RemoteAccessBackend | undefined;

if (process.env.OPEN_BALENA_TUNNEL_URL) {
  try {
    remoteAccess = createRemoteAccessBackend();
    remoteAccess.attach(server);
  } catch (error) {
    console.error('Unable to configure built-in remote access:', error);
  }
}
if (!remoteAccess) {
  attachUnavailableRemoteUpgrade(server);
}
app.use(createApiRouter(remoteAccess?.router));
app.use((_req, res) => {
  res.status(404).json({ message: 'Not found.' });
});

const start = async (): Promise<void> => {
  await bootstrapGlobalAdminFromEnvironment();
  server.listen(PORT, HOST, () => {
    console.log(`Vector server listening on http://${HOST}:${PORT}`);
  });
};

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await remoteAccess?.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

start().catch((error) => {
  console.error('Unable to start the Vector server:', error);
  process.exitCode = 1;
});
