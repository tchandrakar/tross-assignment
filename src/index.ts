import { getConfig } from './config.js';
import { buildServer } from './server.js';
import { closeDispatchers } from './identity/proxy.js';

async function main(): Promise<void> {
  const config = getConfig();
  const { app, shutdown } = await buildServer(config);

  // Cloud Run routes to 0.0.0.0:$PORT; binding to localhost would be invisible.
  await app.listen({ port: config.port, host: '0.0.0.0' });

  const stop = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await shutdown();
      await closeDispatchers();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((error) => {
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
