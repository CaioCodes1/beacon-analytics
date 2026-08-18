import { pool, closeDatabase } from '../src/db/index.js';

/**
 * Recalcula a pré-agregação diária de todos os projetos.
 *
 * Feito para rodar num agendador (cron, Task Scheduler, GitHub Actions), de
 * madrugada. A janela padrão volta 3 dias em vez de recalcular só ontem porque
 * evento atrasado existe: um celular que ficou sem rede envia o lote quando
 * reconecta, e esse evento precisa aparecer no dia em que aconteceu.
 *
 * Como `refresh_daily_rollup` apaga e reinsere a janela, rodar de novo sobre
 * dias já processados é seguro e barato.
 */

const DAYS_BACK = Number(process.env.ROLLUP_DAYS ?? 3);

async function main(): Promise<void> {
  const { rows: projectRows } = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM projects ORDER BY created_at',
  );

  if (projectRows.length === 0) {
    console.log('Nenhum projeto para processar.');
    return;
  }

  console.log(`Rollup dos últimos ${DAYS_BACK} dias — ${projectRows.length} projeto(s)`);

  for (const project of projectRows) {
    const startedAt = Date.now();
    const { rows } = await pool.query<{ refresh_daily_rollup: number }>(
      `SELECT refresh_daily_rollup(
         $1::uuid,
         (now() - ($2::int * interval '1 day'))::date,
         now()::date
       )`,
      [project.id, DAYS_BACK],
    );
    const elapsed = Date.now() - startedAt;
    console.log(
      `  ${project.name}: ${rows[0]?.refresh_daily_rollup ?? 0} linhas em ${elapsed}ms`,
    );
  }

  await pool.query('ANALYZE daily_event_rollup');
}

main()
  .then(closeDatabase)
  .catch(async (error) => {
    console.error(error);
    await closeDatabase();
    process.exit(1);
  });
