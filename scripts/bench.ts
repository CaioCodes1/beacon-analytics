import { pool, closeDatabase } from '../src/db/index.js';

/**
 * Mede as consultas de relatório sobre a massa gerada pelo seed.
 *
 * O objetivo não é produzir um número bonito, é produzir um número *comparável*:
 * cada consulta roda algumas vezes, a primeira execução é descartada (ela paga
 * a leitura do disco para o cache) e o que fica registrado é a mediana.
 *
 * Os planos completos vão para docs/PERFORMANCE.md.
 */

const WARMUP_RUNS = 1;
const MEASURED_RUNS = 5;

interface Benchmark {
  name: string;
  sql: string;
  params: unknown[];
}

function percentileMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

async function timeQuery(bench: Benchmark): Promise<number> {
  for (let run = 0; run < WARMUP_RUNS; run += 1) {
    await pool.query(bench.sql, bench.params);
  }

  const timings: number[] = [];
  for (let run = 0; run < MEASURED_RUNS; run += 1) {
    const startedAt = process.hrtime.bigint();
    await pool.query(bench.sql, bench.params);
    timings.push(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
  }

  return percentileMedian(timings);
}

async function explain(bench: Benchmark): Promise<string> {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${bench.sql}`,
    bench.params,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

async function main(): Promise<void> {
  const { rows: projectRows } = await pool.query<{ id: string }>(
    'SELECT id FROM projects ORDER BY created_at LIMIT 1',
  );
  const projectId = projectRows[0]?.id;

  if (!projectId) {
    console.error('Nenhum projeto encontrado. Rode `npm run db:seed` antes.');
    process.exit(1);
  }

  const { rows: sizeRows } = await pool.query<{ events: number; size: string }>(`
    SELECT
      (SELECT count(*)::bigint FROM events) AS events,
      pg_size_pretty(pg_total_relation_size('events')) AS size
  `);
  console.log(
    `Base: ${Number(sizeRows[0]?.events ?? 0).toLocaleString('pt-BR')} eventos, ` +
      `${sizeRows[0]?.size ?? '?'} em disco\n`,
  );

  const benchmarks: Benchmark[] = [
    {
      name: 'Série diária, 30 dias — tabela bruta',
      params: [projectId],
      sql: `
        SELECT date_trunc('day', occurred_at AT TIME ZONE 'UTC') AS bucket, count(*)
        FROM events
        WHERE project_id = $1::uuid
          AND occurred_at >= now() - interval '30 days'
          AND occurred_at <  now()
        GROUP BY 1 ORDER BY 1
      `,
    },
    {
      name: 'Série diária, 30 dias — rollup',
      params: [projectId],
      sql: `
        SELECT day, sum(event_count)
        FROM daily_event_rollup
        WHERE project_id = $1::uuid
          AND day >= (now() - interval '30 days')::date
        GROUP BY 1 ORDER BY 1
      `,
    },
    {
      name: 'Visitantes únicos, 30 dias',
      params: [projectId],
      sql: `
        SELECT count(DISTINCT anonymous_id)
        FROM events
        WHERE project_id = $1::uuid
          AND occurred_at >= now() - interval '30 days'
      `,
    },
    {
      name: 'Breakdown por país, 30 dias',
      params: [projectId],
      sql: `
        SELECT country, count(*) AS events
        FROM events
        WHERE project_id = $1::uuid
          AND occurred_at >= now() - interval '30 days'
        GROUP BY 1 ORDER BY events DESC
      `,
    },
    {
      name: 'Filtro por propriedade JSONB (índice GIN)',
      params: [projectId],
      sql: `
        SELECT count(*)
        FROM events
        WHERE project_id = $1::uuid
          AND occurred_at >= now() - interval '30 days'
          AND properties @> '{"plano":"enterprise"}'::jsonb
      `,
    },
    {
      name: 'Funil de 3 etapas, 30 dias',
      params: [projectId],
      sql: `
        WITH scoped AS (
          SELECT anonymous_id, name, occurred_at
          FROM events
          WHERE project_id = $1::uuid
            AND occurred_at >= now() - interval '30 days'
            AND name = ANY(ARRAY['page_view','add_to_cart','purchase'])
        ),
        step_0 AS (
          SELECT anonymous_id, min(occurred_at) AS entry_at, min(occurred_at) AS reached_at
          FROM scoped WHERE name = 'page_view' GROUP BY anonymous_id
        ),
        step_1 AS (
          SELECT p.anonymous_id, p.entry_at, min(s.occurred_at) AS reached_at
          FROM step_0 p JOIN scoped s
            ON s.anonymous_id = p.anonymous_id AND s.name = 'add_to_cart'
           AND s.occurred_at >= p.reached_at
           AND s.occurred_at <= p.entry_at + interval '24 hours'
          GROUP BY p.anonymous_id, p.entry_at
        ),
        step_2 AS (
          SELECT p.anonymous_id, p.entry_at, min(s.occurred_at) AS reached_at
          FROM step_1 p JOIN scoped s
            ON s.anonymous_id = p.anonymous_id AND s.name = 'purchase'
           AND s.occurred_at >= p.reached_at
           AND s.occurred_at <= p.entry_at + interval '24 hours'
          GROUP BY p.anonymous_id, p.entry_at
        )
        SELECT 0 AS step, count(*) FROM step_0
        UNION ALL SELECT 1, count(*) FROM step_1
        UNION ALL SELECT 2, count(*) FROM step_2
      `,
    },
    {
      name: 'Retenção diária, 14 coortes',
      params: [projectId],
      sql: `
        WITH cohort AS (
          SELECT anonymous_id, date_trunc('day', min(occurred_at) AT TIME ZONE 'UTC') AS cohort_bucket
          FROM events
          WHERE project_id = $1::uuid AND occurred_at >= now() - interval '14 days'
          GROUP BY anonymous_id
        ),
        activity AS (
          SELECT DISTINCT anonymous_id, date_trunc('day', occurred_at AT TIME ZONE 'UTC') AS active_bucket
          FROM events
          WHERE project_id = $1::uuid AND occurred_at >= now() - interval '14 days'
        )
        SELECT c.cohort_bucket,
               (extract(epoch FROM (a.active_bucket - c.cohort_bucket)) / 86400)::int AS period,
               count(DISTINCT a.anonymous_id)
        FROM cohort c
        JOIN activity a ON a.anonymous_id = c.anonymous_id AND a.active_bucket >= c.cohort_bucket
        GROUP BY 1, 2
      `,
    },
  ];

  const results: { name: string; ms: number }[] = [];

  for (const bench of benchmarks) {
    const ms = await timeQuery(bench);
    results.push({ name: bench.name, ms });
    console.log(`${ms.toFixed(1).padStart(9)} ms   ${bench.name}`);
  }

  console.log('\n--- Planos de execução ---\n');
  for (const bench of benchmarks) {
    console.log(`### ${bench.name}`);
    console.log(await explain(bench));
    console.log('');
  }
}

main()
  .then(closeDatabase)
  .catch(async (error) => {
    console.error(error);
    await closeDatabase();
    process.exit(1);
  });
