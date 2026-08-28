import { sql, eq } from 'drizzle-orm';
import { db, pool, closeDatabase } from '../src/db/index.js';
import { users, projects, apiKeys, events } from '../src/db/schema.js';
import { hashPassword, generateApiKey } from '../src/lib/credentials.js';

/**
 * Gera uma massa de dados sintética grande o bastante para que as decisões de
 * índice e pré-agregação signifiquem alguma coisa.
 *
 * Com 5 mil eventos, qualquer consulta responde em milissegundos e nenhuma
 * otimização se justifica. Os números deste projeto (docs/PERFORMANCE.md) só
 * têm valor porque foram medidos sobre alguns milhões de linhas.
 *
 * A geração acontece **dentro do Postgres**, não em JavaScript. Produzir 2
 * milhões de objetos no Node e mandá-los pela rede levaria minutos e diria mais
 * sobre a velocidade do driver do que sobre o banco. Um `INSERT ... SELECT` a
 * partir de `generate_series` nunca tira os dados do processo do servidor.
 */

const TOTAL_EVENTS = Number(process.env.SEED_EVENTS ?? 2_000_000);
const VISITOR_POOL = Number(process.env.SEED_VISITORS ?? 25_000);
const DAYS_BACK = 90;

/** Média de eventos por sessão, dada a distribuição de profundidade abaixo. */
const AVG_DEPTH = 0.4 * 1 + 0.25 * 2 + 0.17 * 3 + 0.11 * 4 + 0.07 * 5;

const DEMO = {
  name: 'Conta Demo',
  email: 'demo@beacon.dev',
  password: 'beacon123',
  projectName: 'Loja Demo',
};

async function ensureDemoAccount() {
  const [existingUser] = await db.select().from(users).where(eq(users.email, DEMO.email));

  const user =
    existingUser ??
    (
      await db
        .insert(users)
        .values({
          name: DEMO.name,
          email: DEMO.email,
          passwordHash: await hashPassword(DEMO.password),
        })
        .returning()
    )[0]!;

  const [existingProject] = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, user.id))
    .limit(1);

  const project =
    existingProject ??
    (
      await db
        .insert(projects)
        .values({ ownerId: user.id, name: DEMO.projectName, slug: 'loja-demo' })
        .returning()
    )[0]!;

  const generated = generateApiKey();
  await db.insert(apiKeys).values({
    projectId: project.id,
    name: `Seed ${new Date().toISOString().slice(0, 10)}`,
    prefix: generated.prefix,
    keyHash: generated.hash,
  });

  return { user, project, apiKey: generated.plaintext };
}

/**
 * Insere um lote de sessões já expandidas em eventos.
 *
 * A modelagem em duas camadas — sessão e depois etapa — é o que faz os dados
 * responderem de forma realista aos relatórios: os eventos de uma mesma sessão
 * pertencem ao mesmo visitante, acontecem em ordem e ficam minutos um do outro.
 * Sorteando cada evento de forma independente, o funil daria conversão
 * uniforme e a retenção viraria ruído.
 */
async function insertSessionBatch(projectId: string, sessionCount: number): Promise<void> {
  await db.execute(sql`
    WITH raw_sessions AS (
      SELECT
        'anon_' || (1 + floor(random() * ${VISITOR_POOL}::int))::int AS anonymous_id,
        'sess_' || gen_random_uuid()::text                           AS session_id,
        now() - (random() * (${DAYS_BACK}::int * interval '1 day'))  AS started_at,
        random()                                                 AS depth_roll,
        random()                                                 AS country_roll,
        random()                                                 AS device_roll,
        random()                                                 AS plan_roll
      FROM generate_series(1, ${sessionCount}::int)
    ),
    sized_sessions AS (
      SELECT
        *,
        CASE
          WHEN depth_roll < 0.40 THEN 1
          WHEN depth_roll < 0.65 THEN 2
          WHEN depth_roll < 0.82 THEN 3
          WHEN depth_roll < 0.93 THEN 4
          ELSE 5
        END AS depth,
        CASE
          WHEN country_roll < 0.62 THEN 'BR'
          WHEN country_roll < 0.74 THEN 'PT'
          WHEN country_roll < 0.83 THEN 'US'
          WHEN country_roll < 0.90 THEN 'AR'
          WHEN country_roll < 0.95 THEN 'ES'
          ELSE 'MX'
        END AS country,
        CASE
          WHEN device_roll < 0.58 THEN 'mobile'
          WHEN device_roll < 0.92 THEN 'desktop'
          ELSE 'tablet'
        END AS device,
        CASE
          WHEN plan_roll < 0.70 THEN 'free'
          WHEN plan_roll < 0.93 THEN 'pro'
          ELSE 'enterprise'
        END AS plano
      FROM raw_sessions
    )
    INSERT INTO events (
      project_id, name, occurred_at, received_at,
      anonymous_id, session_id, path, referrer,
      country, device, browser, os, properties
    )
    SELECT
      ${projectId}::uuid,
      -- Etapas do funil, em ordem. A profundidade da sessão decide até onde vai.
      (ARRAY['page_view','product_view','add_to_cart','checkout_started','purchase'])[step],
      s.started_at + (step * (random() * interval '3 minutes')),
      now(),
      s.anonymous_id,
      s.session_id,
      (ARRAY['/', '/produtos', '/produtos/camiseta', '/carrinho', '/checkout'])[step],
      (ARRAY['https://google.com', 'https://instagram.com', 'direct', 'https://youtube.com'])[
        1 + floor(random() * 4)::int
      ],
      s.country,
      s.device,
      CASE WHEN s.device = 'mobile' THEN 'Chrome Mobile' ELSE 'Chrome' END,
      CASE WHEN s.device = 'mobile' THEN 'Android' ELSE 'Windows' END,
      jsonb_build_object(
        'plano', s.plano,
        'valor', CASE
          WHEN step = 5 THEN round((random() * 480 + 20)::numeric, 2)
          ELSE NULL
        END
      )
    FROM sized_sessions s
    CROSS JOIN LATERAL generate_series(1, s.depth) AS step
  `);
}

async function main(): Promise<void> {
  console.log('Seed do Beacon Analytics');
  console.log(`  alvo: ~${TOTAL_EVENTS.toLocaleString('pt-BR')} eventos`);

  const { project, apiKey } = await ensureDemoAccount();

  await db.delete(events).where(eq(events.projectId, project.id));

  const totalSessions = Math.ceil(TOTAL_EVENTS / AVG_DEPTH);
  const batchSize = 50_000;
  const batches = Math.ceil(totalSessions / batchSize);
  const startedAt = Date.now();

  for (let batch = 0; batch < batches; batch += 1) {
    const size = Math.min(batchSize, totalSessions - batch * batchSize);
    await insertSessionBatch(project.id, size);
    const done = Math.round(((batch + 1) / batches) * 100);
    process.stdout.write(`\r  gerando... ${done}%   `);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write('\r  gerando... 100%\n');
  console.log(`  eventos inseridos em ${elapsed}s`);

  // ANALYZE atualiza as estatísticas que o planner usa. Sem isso o Postgres
  // ainda acha que a tabela está vazia e escolhe planos ruins — é a causa mais
  // comum de "meu índice não está sendo usado" logo após uma carga grande.
  console.log('  atualizando estatísticas (ANALYZE)...');
  await pool.query('ANALYZE events');

  console.log('  construindo o rollup diário...');
  const rollupStart = Date.now();
  const { rows } = await pool.query<{ refresh_daily_rollup: number }>(
    `SELECT refresh_daily_rollup($1::uuid, (now() - interval '${DAYS_BACK} days')::date, now()::date)`,
    [project.id],
  );
  await pool.query('ANALYZE daily_event_rollup');

  const { rows: countRows } = await pool.query<{ count: number }>(
    'SELECT count(*)::bigint AS count FROM events WHERE project_id = $1',
    [project.id],
  );

  console.log(`  rollup: ${rows[0]?.refresh_daily_rollup ?? 0} linhas em ${((Date.now() - rollupStart) / 1000).toFixed(1)}s`);
  console.log('');
  console.log('Pronto.');
  console.log(`  eventos:  ${Number(countRows[0]?.count ?? 0).toLocaleString('pt-BR')}`);
  console.log(`  projeto:  ${project.id}`);
  console.log(`  login:    ${DEMO.email} / ${DEMO.password}`);
  console.log(`  chave:    ${apiKey}`);
}

main()
  .then(closeDatabase)
  .catch(async (error) => {
    console.error(error);
    await closeDatabase();
    process.exit(1);
  });
