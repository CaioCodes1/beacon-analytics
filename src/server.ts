import { buildApp } from './app.js';
import { env } from './env.js';
import { closeDatabase } from './db/index.js';

const app = await buildApp();

/**
 * Encerramento ordenado.
 *
 * Sem isto, um deploy derruba o processo no meio de requisições em andamento e
 * de transações abertas. `app.close()` para de aceitar conexões novas e espera
 * as em curso terminarem; só depois o pool do Postgres é fechado.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  try {
    await app.close();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'falha ao encerrar');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`documentação em http://localhost:${env.PORT}/docs`);
} catch (error) {
  app.log.error({ err: error }, 'falha ao subir o servidor');
  process.exit(1);
}
