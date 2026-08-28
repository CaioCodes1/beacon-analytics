import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { BadRequestError } from '../../lib/errors.js';
import type {
  ReportFilters,
  Interval,
  BreakdownQuery,
  FunnelQuery,
  RetentionQuery,
  TimeseriesQuery,
} from './reports.schemas.js';

export interface Scoped {
  projectId: string;
}

/** O driver devolve `{ rows }`; esta função esconde essa diferença do resto. */
async function rows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/* -------------------------------------------------------------------------- */
/* Filtros                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Monta o WHERE compartilhado por todos os relatórios.
 *
 * `project_id` e o intervalo de tempo vêm primeiro porque é exatamente a ordem
 * do índice `events_project_time_idx` — igualdade antes do intervalo. Invertida,
 * a varredura não consegue usar o segundo termo para limitar as páginas lidas.
 *
 * Todo valor entra como parâmetro ligado. Nada aqui é concatenado em string.
 */
function baseConditions(
  filters: ReportFilters & Scoped,
  options: { ignoreEvent?: boolean } = {},
): SQL {
  const parts: SQL[] = [
    sql`e.project_id = ${filters.projectId}::uuid`,
    sql`e.occurred_at >= ${filters.from}`,
    sql`e.occurred_at < ${filters.to}`,
  ];

  if (filters.event && !options.ignoreEvent) parts.push(sql`e.name = ${filters.event}`);
  if (filters.path) parts.push(sql`e.path = ${filters.path}`);
  if (filters.country) parts.push(sql`e.country = ${filters.country}`);
  if (filters.device) parts.push(sql`e.device = ${filters.device}`);
  if (filters.browser) parts.push(sql`e.browser = ${filters.browser}`);
  if (filters.os) parts.push(sql`e.os = ${filters.os}`);
  if (filters.properties) {
    // `@>` (contenção) é o operador coberto pelo índice GIN jsonb_path_ops.
    parts.push(sql`e.properties @> ${JSON.stringify(filters.properties)}::jsonb`);
  }

  return sql.join(parts, sql` AND `);
}

/* -------------------------------------------------------------------------- */
/* Visão geral                                                                */
/* -------------------------------------------------------------------------- */

export interface OverviewResult {
  events: number;
  visitors: number;
  sessions: number;
  eventsPerVisitor: number;
  previous: { events: number; visitors: number; sessions: number };
  change: { events: number | null; visitors: number | null; sessions: number | null };
}

/**
 * KPIs do período, com o período imediatamente anterior de mesma duração para
 * comparação. Um número sozinho ("12.400 eventos") não diz nada; a variação diz.
 */
export async function overview(filters: ReportFilters & Scoped): Promise<OverviewResult> {
  const span = filters.to.getTime() - filters.from.getTime();
  const previousFilters = {
    ...filters,
    from: new Date(filters.from.getTime() - span),
    to: filters.from,
  };

  const [row] = await rows<{
    events: number;
    visitors: number;
    sessions: number;
    prev_events: number;
    prev_visitors: number;
    prev_sessions: number;
  }>(sql`
    WITH current_period AS (
      SELECT
        count(*)::bigint                          AS events,
        count(DISTINCT e.anonymous_id)::bigint    AS visitors,
        count(DISTINCT e.session_id)::bigint      AS sessions
      FROM events e
      WHERE ${baseConditions(filters)}
    ),
    previous_period AS (
      SELECT
        count(*)::bigint                          AS events,
        count(DISTINCT e.anonymous_id)::bigint    AS visitors,
        count(DISTINCT e.session_id)::bigint      AS sessions
      FROM events e
      WHERE ${baseConditions(previousFilters)}
    )
    SELECT
      c.events, c.visitors, c.sessions,
      p.events   AS prev_events,
      p.visitors AS prev_visitors,
      p.sessions AS prev_sessions
    FROM current_period c CROSS JOIN previous_period p
  `);

  const current = row ?? {
    events: 0,
    visitors: 0,
    sessions: 0,
    prev_events: 0,
    prev_visitors: 0,
    prev_sessions: 0,
  };

  // Variação percentual sobre uma base zero é indefinida, não infinita.
  const percentChange = (now: number, before: number): number | null =>
    before === 0 ? null : Number((((now - before) / before) * 100).toFixed(2));

  return {
    events: current.events,
    visitors: current.visitors,
    sessions: current.sessions,
    eventsPerVisitor:
      current.visitors === 0 ? 0 : Number((current.events / current.visitors).toFixed(2)),
    previous: {
      events: current.prev_events,
      visitors: current.prev_visitors,
      sessions: current.prev_sessions,
    },
    change: {
      events: percentChange(current.events, current.prev_events),
      visitors: percentChange(current.visitors, current.prev_visitors),
      sessions: percentChange(current.sessions, current.prev_sessions),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Série temporal                                                             */
/* -------------------------------------------------------------------------- */

const INTERVAL_STEP: Record<Interval, string> = {
  hour: '1 hour',
  day: '1 day',
  week: '1 week',
  month: '1 month',
};

const INTERVAL_MS: Record<Interval, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
};

const MAX_BUCKETS = 1000;

export interface TimeseriesPoint {
  bucket: string;
  events: number;
  visitors: number;
  sessions: number;
}

export interface TimeseriesResult {
  interval: Interval;
  metric: string;
  timezone: string;
  /** De onde veio a resposta. Útil para entender a latência observada. */
  source: 'rollup' | 'raw';
  points: TimeseriesPoint[];
}

/**
 * O rollup diário só pode responder quando a pergunta cabe na forma em que ele
 * foi gravado. Cada condição abaixo é uma limitação real, não uma precaução:
 *
 *  - granularidade de hora não existe no rollup (ele é diário);
 *  - o rollup agrupa por data UTC, então qualquer outro fuso deslocaria as
 *    fronteiras dos dias e daria números sutilmente errados;
 *  - `sessions` não foi pré-agregado;
 *  - visitantes únicos **não são somáveis**: 100 únicos na segunda e 100 na
 *    terça não são 200 na semana. Por isso únicos só saem do rollup na
 *    granularidade exata em que foram gravados (dia);
 *  - filtros por caminho, navegador, SO ou propriedade não existem como
 *    dimensão no rollup.
 *
 * Não cabendo, a consulta vai para a tabela bruta. A resposta é sempre correta;
 * o que muda é o tempo.
 */
/**
 * O rollup só entra em cena se puder responder CERTO.
 *
 * São duas perguntas independentes, e antes só a primeira era feita.
 *
 * A primeira é sobre o FORMATO da pergunta: a pré-agregação é gravada por dia,
 * em UTC, e guarda únicos por dia. Fora dessas condições ela mentiria por
 * construção — somar únicos de dias diferentes conta duas vezes quem voltou, e
 * um fuso diferente move a fronteira do dia.
 *
 * A segunda é sobre os DADOS: o rollup tem esse período processado? Ela faltava,
 * e a consequência era grave. Um rollup vazio, ou simplesmente mais antigo que
 * a pergunta, devolvia zeros — sem erro e sem aviso. O gráfico mostrava um
 * período sem tráfego que na verdade estava cheio de eventos.
 *
 * `rollup_coverage` responde a segunda pergunta. Olhar os dias presentes em
 * `daily_event_rollup` não serviria: a ausência de linha lá é ambígua entre
 * "nunca processado" e "processado e vazio", e essas duas situações pedem
 * respostas opostas.
 *
 * A dúvida sempre cai para a tabela bruta: mais lento e certo é melhor que
 * rápido e errado.
 */
async function canUseRollup(query: TimeseriesQuery & Scoped): Promise<boolean> {
  if (query.interval === 'hour') return false;
  if (query.timezone !== 'UTC') return false;
  if (query.metric === 'sessions') return false;
  if (query.metric === 'visitors' && query.interval !== 'day') return false;
  if (query.path || query.browser || query.os || query.properties) return false;

  return rollupCoversRange(query);
}

/**
 * Todo dia do intervalo pedido está registrado como processado?
 *
 * A régua é a mesma do relatório: `to` é exclusivo, então o último dia sai de
 * `to` menos um microssegundo. Sem isso, um intervalo terminando na virada
 * exata do dia exigiria cobertura de um dia a mais do que ele de fato lê.
 */
async function rollupCoversRange(query: TimeseriesQuery & Scoped): Promise<boolean> {
  const [row] = await rows<{ covered: boolean }>(sql`
    SELECT NOT EXISTS (
      SELECT 1
      FROM generate_series(
        (${query.from}::timestamptz AT TIME ZONE 'UTC')::date,
        ((${query.to}::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date,
        interval '1 day'
      ) AS d
      WHERE NOT EXISTS (
        SELECT 1
        FROM rollup_coverage c
        WHERE c.project_id = ${query.projectId}::uuid
          AND c.day = d::date
      )
    ) AS covered
  `);

  return row?.covered === true;
}

function assertBucketBudget(query: TimeseriesQuery): void {
  const span = query.to.getTime() - query.from.getTime();
  const buckets = Math.ceil(span / INTERVAL_MS[query.interval]);
  if (buckets > MAX_BUCKETS) {
    throw new BadRequestError(
      `O intervalo pedido geraria ${buckets} pontos (limite: ${MAX_BUCKETS}). ` +
        'Reduza o período ou aumente a granularidade.',
      'RANGE_TOO_LARGE',
    );
  }
}

/**
 * Série temporal com preenchimento de lacunas.
 *
 * Um `GROUP BY` puro só devolve os períodos que tiveram eventos — um dia sem
 * tráfego simplesmente some do resultado, e o gráfico do cliente liga o dia 3
 * ao dia 5 como se o 4 não existisse. `generate_series` cria a régua completa e
 * o LEFT JOIN encaixa os dados nela, com zero onde não houve nada.
 */
export async function timeseries(
  query: TimeseriesQuery & Scoped,
): Promise<TimeseriesResult> {
  assertBucketBudget(query);

  const step = INTERVAL_STEP[query.interval];
  const useRollup = await canUseRollup(query);

  // A régua é a mesma nos dois caminhos. O limite superior desconta um
  // microssegundo porque `to` é exclusivo: sem isso, um intervalo fechado num
  // limite exato de dia geraria um período vazio a mais no fim.
  // A régua sai de `from` e `to` como o cliente os escreveu, sem converter de
  // fuso. É uma decisão de produto, e a alternativa é pior.
  //
  // Antes a régua convertia os limites para o fuso pedido. O efeito aparece no
  // exemplo do próprio README: pedir `from=2026-07-01`, `to=2026-08-01` com
  // `timezone=America/Sao_Paulo` devolvia um período de 30 de JUNHO, porque
  // 1º de julho 00:00 UTC é 30 de junho 21:00 em São Paulo. Quem pediu julho
  // recebia junho na primeira linha do gráfico.
  //
  // `from` e `to` nomeiam os dias; `timezone` diz onde cai a fronteira do dia.
  // A conversão de fuso continua acontecendo onde importa — na agregação, que
  // é quem decide em qual período cada evento cai.
  const series = sql`
    SELECT generate_series(
      date_trunc(${query.interval}, ${query.from}::timestamptz AT TIME ZONE 'UTC'),
      date_trunc(
        ${query.interval},
        (${query.to}::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC'
      ),
      ${step}::interval
    ) AS bucket
  `;

  const aggregate = useRollup
    ? sql`
        SELECT
          date_trunc(${query.interval}, r.day::timestamp) AS bucket,
          sum(r.event_count)::bigint                      AS events,
          sum(r.unique_visitors)::bigint                  AS visitors,
          0::bigint                                       AS sessions
        FROM daily_event_rollup r
        WHERE ${sql.join(
          [
            sql`r.project_id = ${query.projectId}::uuid`,
            sql`r.day >= (${query.from}::timestamptz AT TIME ZONE 'UTC')::date`,
            sql`r.day <= ((${query.to}::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC')::date`,
            ...(query.event ? [sql`r.event_name = ${query.event}`] : []),
            ...(query.country ? [sql`r.country = ${query.country}`] : []),
            ...(query.device ? [sql`r.device = ${query.device}`] : []),
          ],
          sql` AND `,
        )}
        GROUP BY 1
      `
    : sql`
        SELECT
          date_trunc(${query.interval}, e.occurred_at AT TIME ZONE ${query.timezone}) AS bucket,
          count(*)::bigint                       AS events,
          count(DISTINCT e.anonymous_id)::bigint AS visitors,
          count(DISTINCT e.session_id)::bigint   AS sessions
        FROM events e
        WHERE ${baseConditions(query)}
        GROUP BY 1
      `;

  const points = await rows<TimeseriesPoint>(sql`
    WITH series AS (${series}),
         aggregated AS (${aggregate})
    SELECT
      to_char(s.bucket, 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
      COALESCE(a.events, 0)::bigint                AS events,
      COALESCE(a.visitors, 0)::bigint              AS visitors,
      COALESCE(a.sessions, 0)::bigint              AS sessions
    FROM series s
    LEFT JOIN aggregated a ON a.bucket = s.bucket
    ORDER BY s.bucket
  `);

  return {
    interval: query.interval,
    metric: query.metric,
    timezone: query.timezone,
    source: useRollup ? 'rollup' : 'raw',
    points,
  };
}

/* -------------------------------------------------------------------------- */
/* Breakdown por dimensão                                                     */
/* -------------------------------------------------------------------------- */

const UNKNOWN_LABEL = '(não informado)';
const OTHER_LABEL = 'Outros';

/**
 * Traduz o nome público da dimensão na expressão SQL correspondente.
 *
 * O `switch` sobre uma lista fechada é o que torna isso seguro: nenhuma string
 * do cliente vira SQL. No caso `prop:`, a chave é o único trecho variável — e
 * ela entra como parâmetro ligado dentro do operador `->>`.
 */
function dimensionExpression(dimension: string): SQL {
  switch (dimension) {
    case 'event':
      return sql`e.name`;
    case 'path':
      return sql`e.path`;
    case 'country':
      return sql`e.country`;
    case 'device':
      return sql`e.device`;
    case 'browser':
      return sql`e.browser`;
    case 'os':
      return sql`e.os`;
    case 'referrer':
      return sql`e.referrer`;
    default: {
      const key = dimension.slice('prop:'.length);
      return sql`e.properties ->> ${key}`;
    }
  }
}

export interface BreakdownRow {
  value: string;
  events: number;
  /** `null` na linha "Outros" — ver comentário abaixo. */
  visitors: number | null;
  share: number;
}

/**
 * Top N de uma dimensão, com a cauda somada em "Outros".
 *
 * `row_number()` ordena tudo em uma passada e `sum(...) OVER ()` calcula o total
 * na mesma consulta — sem funções de janela seriam duas idas ao banco, ou uma
 * subconsulta repetindo a agregação inteira só para descobrir o denominador.
 *
 * A linha "Outros" traz `visitors = null` de propósito. Somar visitantes únicos
 * de valores diferentes conta duas vezes quem apareceu em mais de um: alguém que
 * acessou por celular e por desktop é um visitante, não dois. Eventos somam;
 * únicos não. Devolver `null` é mais honesto que devolver um número inflado.
 */
export async function breakdown(query: BreakdownQuery & Scoped): Promise<BreakdownRow[]> {
  return rows<BreakdownRow>(sql`
    WITH aggregated AS (
      SELECT
        COALESCE(${dimensionExpression(query.dimension)}::text, ${UNKNOWN_LABEL}) AS value,
        count(*)::bigint                       AS events,
        count(DISTINCT e.anonymous_id)::bigint AS visitors
      FROM events e
      WHERE ${baseConditions(query)}
      GROUP BY 1
    ),
    ranked AS (
      SELECT
        value,
        events,
        visitors,
        row_number() OVER (ORDER BY events DESC, value ASC) AS position,
        (sum(events) OVER ())::bigint                       AS grand_total
      FROM aggregated
    ),
    grouped AS (
      SELECT
        CASE WHEN position <= ${query.limit} THEN value ELSE ${OTHER_LABEL} END AS value,
        sum(events)::bigint AS events,
        (CASE WHEN min(position) <= ${query.limit} THEN max(visitors) END)::bigint AS visitors,
        ROUND(100.0 * sum(events) / NULLIF(max(grand_total), 0), 2)::float8 AS share
      FROM ranked
      GROUP BY 1
    )
    SELECT value, events, visitors, share
    FROM grouped
    -- "Outros" sai sempre por último, mesmo empatado em eventos com uma linha
    -- real. Sem o primeiro critério, o desempate alfabético jogava a
    -- linha-agregado para o meio do ranking: com US e Outros empatados em 3,
    -- "O" vem antes de "U" e o resultado saía BR, Outros, US. "Outros" não
    -- disputa posição com ninguém — ele é o resto.
    --
    -- A ordenação precisa da CTE grouped em vez de vir junto do GROUP BY:
    -- dentro de uma expressão do ORDER BY, o value resolve para a coluna de
    -- ENTRADA (ranked.value), não para o apelido de saída, e o Postgres recusa
    -- com "coluna ranked.value deve aparecer na cláusula GROUP BY".
    ORDER BY (value = ${OTHER_LABEL}) ASC, events DESC, value ASC
  `);
}

/* -------------------------------------------------------------------------- */
/* Funil                                                                      */
/* -------------------------------------------------------------------------- */

export interface FunnelStep {
  step: number;
  name: string;
  visitors: number;
  /** Conversão em relação à etapa anterior. */
  stepRate: number | null;
  /** Conversão em relação à entrada no funil. */
  overallRate: number | null;
  /** Mediana do tempo entre entrar no funil e chegar nesta etapa. */
  medianSecondsFromEntry: number;
}

/**
 * Funil de conversão.
 *
 * A dificuldade não é contar quem disparou cada evento — é contar quem os
 * disparou **na ordem certa e dentro da janela**. Alguém que finalizou uma
 * compra hoje e visitou o produto amanhã não converteu; um `GROUP BY` por nome
 * de evento contaria essa pessoa nas duas etapas.
 *
 * A solução é uma cadeia de CTEs: cada etapa parte apenas de quem sobreviveu à
 * anterior (`JOIN` com a CTE de cima) e só aceita eventos posteriores ao momento
 * em que a etapa anterior foi atingida (`s.occurred_at >= p.reached_at`). A
 * janela é medida a partir da entrada no funil, não da etapa anterior — é assim
 * que se lê "converteu em até 24h".
 *
 * A cadeia é montada em TypeScript porque o número de etapas é dinâmico. Os
 * únicos trechos interpolados são os identificadores `step_0`, `step_1`, ...,
 * gerados a partir do índice do laço; os nomes dos eventos, que vêm do cliente,
 * são sempre parâmetros ligados.
 */
export async function funnel(query: FunnelQuery & Scoped): Promise<FunnelStep[]> {
  const { steps } = query;
  const windowInterval = query.window.endsWith('h')
    ? `${parseInt(query.window, 10)} hours`
    : `${parseInt(query.window, 10)} days`;

  const stepCtes: SQL[] = [
    sql`step_0 AS (
      SELECT
        anonymous_id,
        min(occurred_at) AS entry_at,
        min(occurred_at) AS reached_at
      FROM scoped
      WHERE name = ${steps[0]}
      GROUP BY anonymous_id
    )`,
  ];

  for (let i = 1; i < steps.length; i += 1) {
    const current = sql.raw(`step_${i}`);
    const previous = sql.raw(`step_${i - 1}`);
    stepCtes.push(sql`${current} AS (
      SELECT
        p.anonymous_id,
        p.entry_at,
        min(s.occurred_at) AS reached_at
      FROM ${previous} p
      JOIN scoped s
        ON s.anonymous_id  = p.anonymous_id
       AND s.name          = ${steps[i]}
       AND s.occurred_at  >= p.reached_at
       AND s.occurred_at  <= p.entry_at + ${windowInterval}::interval
      GROUP BY p.anonymous_id, p.entry_at
    )`);
  }

  const stepSelects: SQL[] = steps.map((_, index) => {
    const table = sql.raw(`step_${index}`);
    if (index === 0) {
      return sql`SELECT 0::int AS step_index, count(*)::bigint AS visitors, 0::float8 AS median_seconds FROM step_0`;
    }
    return sql`
      SELECT
        ${index}::int      AS step_index,
        count(*)::bigint   AS visitors,
        COALESCE(
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(epoch FROM (reached_at - entry_at))
          ),
          0
        )::float8 AS median_seconds
      FROM ${table}
    `;
  });

  const result = await rows<{ step_index: number; visitors: number; median_seconds: number }>(sql`
    WITH scoped AS (
      SELECT e.anonymous_id, e.name, e.occurred_at
      FROM events e
      WHERE ${baseConditions(query, { ignoreEvent: true })}
        -- sql.param liga o array como UM parametro. Sem ele, o Drizzle expande
        -- a lista em uma tupla - ANY(($4, $5, $6)::text[]) - e o Postgres
        -- recusa: "nao e possivel converter o tipo de dados record para
        -- text[]". O endpoint respondia 500.
        AND e.name = ANY(${sql.param(steps)}::text[])
    ),
    ${sql.join(stepCtes, sql`, `)}
    ${sql.join(stepSelects, sql` UNION ALL `)}
    ORDER BY step_index
  `);

  const entryCount = result[0]?.visitors ?? 0;

  return result.map((row, index) => {
    const previousCount = index === 0 ? null : (result[index - 1]?.visitors ?? 0);
    const rate = (part: number, whole: number | null): number | null =>
      whole === null || whole === 0 ? null : Number(((part / whole) * 100).toFixed(2));

    return {
      step: row.step_index,
      name: steps[index]!,
      visitors: row.visitors,
      stepRate: rate(row.visitors, previousCount),
      overallRate: index === 0 ? 100 : rate(row.visitors, entryCount),
      medianSecondsFromEntry: Math.round(row.median_seconds),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Retenção por coorte                                                        */
/* -------------------------------------------------------------------------- */

export interface RetentionCohort {
  cohort: string;
  size: number;
  periods: { period: number; retained: number; rate: number }[];
}

const SECONDS_PER_PERIOD = { day: 86_400, week: 604_800 } as const;

/**
 * Matriz de retenção por coorte.
 *
 * Agrupa os visitantes pelo período em que apareceram pela primeira vez (a
 * coorte) e mede quantos voltaram em cada período seguinte. É a pergunta que
 * separa crescimento real de rotatividade: 1.000 visitantes novos por mês não
 * significam nada se nenhum deles volta.
 *
 * O índice do período é a distância entre o período de atividade e o da coorte,
 * dividida pela duração fixa do período — e é justamente por isso que "mês" não
 * é aceito: fevereiro e março têm durações diferentes, e a divisão daria
 * fronteiras erradas.
 */
export async function retention(query: RetentionQuery & Scoped): Promise<RetentionCohort[]> {
  const secondsPerPeriod = SECONDS_PER_PERIOD[query.granularity];
  const base = baseConditions(query, { ignoreEvent: true });

  const cohortConditions = query.cohortEvent
    ? sql`${base} AND e.name = ${query.cohortEvent}`
    : base;
  const returnConditions = query.returnEvent
    ? sql`${base} AND e.name = ${query.returnEvent}`
    : base;

  const flat = await rows<{
    cohort: string;
    size: number;
    period: number;
    retained: number;
    rate: number;
  }>(sql`
    WITH cohort AS (
      SELECT
        e.anonymous_id,
        date_trunc(${query.granularity}, min(e.occurred_at) AT TIME ZONE ${query.timezone}) AS cohort_bucket
      FROM events e
      WHERE ${cohortConditions}
      GROUP BY e.anonymous_id
    ),
    activity AS (
      SELECT DISTINCT
        e.anonymous_id,
        date_trunc(${query.granularity}, e.occurred_at AT TIME ZONE ${query.timezone}) AS active_bucket
      FROM events e
      WHERE ${returnConditions}
    ),
    sizes AS (
      SELECT cohort_bucket, count(*)::bigint AS size
      FROM cohort
      GROUP BY cohort_bucket
    ),
    matrix AS (
      SELECT
        c.cohort_bucket,
        (extract(epoch FROM (a.active_bucket - c.cohort_bucket)) / ${secondsPerPeriod})::int AS period,
        count(DISTINCT a.anonymous_id)::bigint AS retained
      FROM cohort c
      JOIN activity a
        ON a.anonymous_id  = c.anonymous_id
       AND a.active_bucket >= c.cohort_bucket
      GROUP BY c.cohort_bucket, 2
    )
    SELECT
      to_char(s.cohort_bucket, 'YYYY-MM-DD') AS cohort,
      s.size,
      m.period,
      m.retained,
      ROUND(100.0 * m.retained / NULLIF(s.size, 0), 2)::float8 AS rate
    FROM sizes s
    JOIN matrix m ON m.cohort_bucket = s.cohort_bucket
    WHERE m.period <= ${query.periods}
    ORDER BY s.cohort_bucket, m.period
  `);

  // O banco devolve a matriz achatada; agrupar em TypeScript é mais barato que
  // pedir ao Postgres para montar JSON aninhado.
  const byCohort = new Map<string, RetentionCohort>();
  for (const row of flat) {
    let cohort = byCohort.get(row.cohort);
    if (!cohort) {
      cohort = { cohort: row.cohort, size: row.size, periods: [] };
      byCohort.set(row.cohort, cohort);
    }
    cohort.periods.push({ period: row.period, retained: row.retained, rate: row.rate });
  }

  return [...byCohort.values()];
}

/* -------------------------------------------------------------------------- */
/* Manutenção do rollup                                                       */
/* -------------------------------------------------------------------------- */

export async function refreshRollup(
  projectId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const [row] = await rows<{ refresh_daily_rollup: number }>(sql`
    SELECT refresh_daily_rollup(
      ${projectId}::uuid,
      (${from}::timestamptz AT TIME ZONE 'UTC')::date,
      (${to}::timestamptz AT TIME ZONE 'UTC')::date
    )
  `);
  return row?.refresh_daily_rollup ?? 0;
}
