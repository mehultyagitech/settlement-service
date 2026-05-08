import { createApp } from './app';
import { rootLogger } from './utils/logger';
import { getDb, closeDb } from './db/database';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function main() {
  try {
    await getDb();
    rootLogger.info('Database initialized');
  } catch (err) {
    rootLogger.fatal({ err }, 'Failed to initialize database — exiting');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(PORT, () => {
    rootLogger.info({ port: PORT }, 'Settlement service listening');
  });

  const shutdown = (signal: string) => {
    rootLogger.info({ signal }, 'Shutting down gracefully');
    server.close(() => {
      rootLogger.info('HTTP server closed');
      closeDb();
      rootLogger.info('Database closed — shutdown complete');
      process.exit(0);
    });
    setTimeout(() => { rootLogger.error('Shutdown timed out — forcing exit'); process.exit(1); }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { rootLogger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
  process.on('unhandledRejection', (reason) => { rootLogger.fatal({ reason }, 'Unhandled rejection'); process.exit(1); });
}

main();
