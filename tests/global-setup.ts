import { Client } from 'pg';

/**
 * Prepara um banco limpo antes da suíte.
 *
 * Testar consultas analíticas contra um mock não prova nada: quem executa
 * `date_trunc`, `percentile_cont` e as funções de janela é o Postgres. Um erro
 * de fuso ou de fronteira de intervalo só aparece com o banco de verdade no
 * meio — que é justamente onde esse tipo de erro costuma se esconder.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://beacon:beacon@localhost:5433/beacon_test';

function maintenanceUrl(databaseUrl: string): { url: string; database: string } {
  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.slice(1);
  parsed.pathname = '/postgres';
  return { url: parsed.toString(), database };
}

export async function setup(): Promise<void> {
  const { url, database } = maintenanceUrl(TEST_DATABASE_URL);

  const admin = new Client({ connectionString: url });
  await admin.connect();

  // Recriar do zero é mais confiável que limpar: garante que as migrations
  // realmente rodam de ponta a ponta a cada execução da suíte.
  await admin.query(`DROP DATABASE IF EXISTS ${JSON.stringify(database)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${JSON.stringify(database)}`);
  await admin.end();

  // O módulo de banco lê a configuração no momento do import, então a variável
  // precisa estar no lugar antes de qualquer import dele.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.JWT_SECRET ??= 'chave-de-teste-com-pelo-menos-32-caracteres-ok';

  const { runMigrations } = await import('../src/db/migrate.js');
  const { closeDatabase } = await import('../src/db/index.js');

  await runMigrations();
  await closeDatabase();
}
