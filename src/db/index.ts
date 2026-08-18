import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { env } from '../env.js';

/**
 * `bigint` do Postgres chega como string no driver, porque não cabe em um
 * `number` do JavaScript. Contagens de analytics cabem com folga, então os
 * tipos 20 (int8) e 1700 (numeric) são convertidos para número — caso
 * contrário todo `count(*)` voltaria como "1234" e somas viravam concatenação.
 */
import pg from 'pg';
pg.types.setTypeParser(20, (value) => Number(value));
pg.types.setTypeParser(1700, (value) => Number(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Relatórios pesados não podem prender uma conexão para sempre.
  statement_timeout: 30_000,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export { schema };

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
