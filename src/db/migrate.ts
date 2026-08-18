import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closeDatabase } from './index.js';

/**
 * Runner de migrations.
 *
 * Escrito à mão, e não delegado ao ORM, por dois motivos:
 *
 *  1. as migrations deste projeto contêm SQL que nenhum gerador produz
 *     (CHECK constraints, índice GIN, função plpgsql);
 *  2. cada arquivo roda dentro de uma transação — se qualquer statement falhar,
 *     nada daquele arquivo fica aplicado pela metade. Postgres suporta DDL
 *     transacional, e é uma das melhores razões para usá-lo.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  return new Set(rows.map((row) => row.filename));
}

export async function runMigrations(): Promise<string[]> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const executed: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      // O marcador é o que o drizzle-kit escreve entre statements; para o
      // Postgres é apenas um comentário, então o arquivo roda de uma vez.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      executed.push(file);
      console.log(`  aplicada  ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`  FALHOU    ${file}`);
      throw error;
    } finally {
      client.release();
    }
  }

  return executed;
}

// Só executa quando chamado direto pela CLI (`npm run db:migrate`), nunca
// quando importado pelos testes.
const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (isCli) {
  console.log('Migrations:');
  runMigrations()
    .then(async (executed) => {
      console.log(
        executed.length === 0
          ? '  nada a fazer — banco já está atualizado'
          : `  ${executed.length} migration(s) aplicada(s)`,
      );
      await closeDatabase();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDatabase();
      process.exit(1);
    });
}
