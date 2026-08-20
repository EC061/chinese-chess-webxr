/**
 * Process bootstrap: read the environment, start the app, shut down cleanly.
 * All of the actual wiring lives in `app.ts`.
 */
import { createApp } from './app.js';
import { createLogger, loadConfig } from './config.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
const app = createApp(config);

await app.listen();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  // Never hang a container restart on a stuck socket.
  const guard = setTimeout(() => process.exit(0), 8000);
  guard.unref();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});
