import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, resetDatabase, createAccount, auth, type TestAccount } from './helpers.js';
import { db, closeDatabase } from '../src/db/index.js';
import { events } from '../src/db/schema.js';

let app: FastifyInstance;
let account: TestAccount;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount(app);
});

/** Datas fixas: relatório com data relativa a `now()` é teste que falha sozinho. */
const at = (iso: string) => new Date(iso);

interface Fixture {
  name: string;
  anonymousId: string;
  occurredAt: string;
  country?: string;
  device?: 'desktop' | 'mobile' | 'tablet';
  sessionId?: string;
  properties?: Record<string, string | number | boolean | null>;
}

async function seed(fixtures: Fixture[]): Promise<void> {
  await db.insert(events).values(
    fixtures.map((fixture) => ({
      projectId: account.projectId,
      name: fixture.name,
      anonymousId: fixture.anonymousId,
      occurredAt: at(fixture.occurredAt),
      country: fixture.country ?? null,
      device: fixture.device ?? null,
      sessionId: fixture.sessionId ?? null,
      properties: fixture.properties ?? {},
    })),
  );
}

function report(path: string, query: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `/v1/projects/${account.projectId}/reports/${path}`,
    query,
    headers: auth(account.token),
  });
}

/* -------------------------------------------------------------------------- */

describe('série temporal', () => {
  it('preenche com zero os períodos sem eventos', async () => {
    await seed([
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T12:00:00Z' },
      // 2 de junho não tem nada — e precisa aparecer no resultado mesmo assim.
      { name: 'page_view', anonymousId: 'b', occurredAt: '2026-06-03T10:00:00Z' },
    ]);

    const response = await report('timeseries', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      interval: 'day',
    });

    const body = response.json<{ points: { bucket: string; events: number }[] }>();
    expect(body.points).toHaveLength(3);
    expect(body.points.map((point) => point.events)).toEqual([2, 0, 1]);
    expect(body.points[1]!.bucket).toBe('2026-06-02T00:00:00');
  });

  it('não cria um período extra quando `to` cai exatamente na virada do dia', async () => {
    await seed([{ name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' }]);

    const response = await report('timeseries', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
      interval: 'day',
    });

    // `to` é exclusivo: o intervalo cobre um dia só.
    expect(response.json<{ points: unknown[] }>().points).toHaveLength(1);
  });

  it('agrupa nas fronteiras do fuso pedido, não nas de UTC', async () => {
    // 02/06 01:00 UTC é 01/06 22:00 em São Paulo (UTC-3).
    await seed([{ name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-02T01:00:00Z' }]);

    const inUtc = await report('timeseries', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-03T00:00:00Z',
      interval: 'day',
    });

    const inSaoPaulo = await report('timeseries', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-03T00:00:00Z',
      interval: 'day',
      timezone: 'America/Sao_Paulo',
    });

    expect(inUtc.json<{ points: { events: number }[] }>().points.map((p) => p.events)).toEqual([
      0, 1,
    ]);
    expect(
      inSaoPaulo.json<{ points: { events: number }[] }>().points.map((p) => p.events),
    ).toEqual([1, 0]);
  });

  it('conta visitantes únicos, não eventos', async () => {
    await seed([
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T11:00:00Z' },
      { name: 'page_view', anonymousId: 'b', occurredAt: '2026-06-01T12:00:00Z' },
    ]);

    const response = await report('timeseries', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
      interval: 'day',
      metric: 'visitors',
    });

    const [point] = response.json<{ points: { events: number; visitors: number }[] }>().points;
    expect(point!.events).toBe(3);
    expect(point!.visitors).toBe(2);
  });

  it('recusa um intervalo que geraria pontos demais', async () => {
    const response = await report('timeseries', {
      from: '2020-01-01T00:00:00Z',
      to: '2026-01-01T00:00:00Z',
      interval: 'hour',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('RANGE_TOO_LARGE');
  });
});

/* -------------------------------------------------------------------------- */

describe('pré-agregação', () => {
  it('devolve o mesmo resultado pelo rollup e pela tabela bruta', async () => {
    await seed([
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'page_view', anonymousId: 'b', occurredAt: '2026-06-01T11:00:00Z' },
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-02T10:00:00Z' },
    ]);

    const range = { from: '2026-06-01T00:00:00Z', to: '2026-06-03T00:00:00Z' };

    const beforeRollup = await report('timeseries', { ...range, interval: 'day' });
    expect(beforeRollup.json<{ source: string }>().source).toBe('raw');

    await app.inject({
      method: 'POST',
      url: `/v1/projects/${account.projectId}/rollup`,
      headers: auth(account.token),
      payload: { from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' },
    });

    const afterRollup = await report('timeseries', { ...range, interval: 'day' });
    expect(afterRollup.json<{ source: string }>().source).toBe('rollup');

    // O caminho rápido não pode mudar a resposta — só o tempo dela.
    expect(afterRollup.json<{ points: { events: number }[] }>().points.map((p) => p.events)).toEqual(
      beforeRollup.json<{ points: { events: number }[] }>().points.map((p) => p.events),
    );
  });

  it('volta para a tabela bruta quando o fuso não é UTC', async () => {
    await seed([{ name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' }]);

    await app.inject({
      method: 'POST',
      url: `/v1/projects/${account.projectId}/rollup`,
      headers: auth(account.token),
      payload: { from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' },
    });

    const response = await report('timeseries', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
      interval: 'day',
      timezone: 'America/Sao_Paulo',
    });

    // O rollup é gravado por data UTC; em outro fuso ele daria números errados.
    expect(response.json<{ source: string }>().source).toBe('raw');
  });
});

/* -------------------------------------------------------------------------- */

describe('breakdown', () => {
  beforeEach(async () => {
    await seed([
      ...Array.from({ length: 5 }, (_, i) => ({
        name: 'page_view',
        anonymousId: `br_${i}`,
        occurredAt: '2026-06-01T10:00:00Z',
        country: 'BR',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        name: 'page_view',
        anonymousId: `us_${i}`,
        occurredAt: '2026-06-01T10:00:00Z',
        country: 'US',
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        name: 'page_view',
        anonymousId: `pt_${i}`,
        occurredAt: '2026-06-01T10:00:00Z',
        country: 'PT',
      })),
      {
        name: 'page_view',
        anonymousId: 'ar_0',
        occurredAt: '2026-06-01T10:00:00Z',
        country: 'AR',
      },
    ]);
  });

  const range = { from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00Z' };

  it('agrupa a cauda em "Outros"', async () => {
    const response = await report('breakdown', { ...range, dimension: 'country', limit: '2' });
    const body = response.json<{ value: string; events: number; visitors: number | null }[]>();

    expect(body.map((row) => [row.value, row.events])).toEqual([
      ['BR', 5],
      ['US', 3],
      ['Outros', 3],
    ]);
  });

  it('não informa visitantes únicos na linha "Outros"', async () => {
    const response = await report('breakdown', { ...range, dimension: 'country', limit: '2' });
    const body = response.json<{ value: string; visitors: number | null }[]>();

    expect(body.find((row) => row.value === 'BR')!.visitors).toBe(5);
    // Somar únicos de países diferentes contaria duas vezes quem apareceu em
    // mais de um. `null` é a resposta honesta.
    expect(body.find((row) => row.value === 'Outros')!.visitors).toBeNull();
  });

  it('calcula a participação de cada linha sobre o total', async () => {
    const response = await report('breakdown', { ...range, dimension: 'country', limit: '2' });
    const body = response.json<{ value: string; share: number }[]>();

    const total = body.reduce((sum, row) => sum + row.share, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('agrupa por propriedade customizada', async () => {
    await seed([
      {
        name: 'purchase',
        anonymousId: 'x',
        occurredAt: '2026-06-01T10:00:00Z',
        properties: { plano: 'pro' },
      },
      {
        name: 'purchase',
        anonymousId: 'y',
        occurredAt: '2026-06-01T10:00:00Z',
        properties: { plano: 'pro' },
      },
      {
        name: 'purchase',
        anonymousId: 'z',
        occurredAt: '2026-06-01T10:00:00Z',
        properties: { plano: 'free' },
      },
    ]);

    const response = await report('breakdown', {
      ...range,
      dimension: 'prop:plano',
      event: 'purchase',
      limit: '10',
    });

    expect(response.json<{ value: string; events: number }[]>()).toEqual([
      { value: 'pro', events: 2, visitors: 2, share: 66.67 },
      { value: 'free', events: 1, visitors: 1, share: 33.33 },
    ]);
  });

  it('recusa uma dimensão fora da lista permitida', async () => {
    const response = await report('breakdown', {
      ...range,
      dimension: 'name; DROP TABLE events',
    });

    expect(response.statusCode).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe('funil', () => {
  beforeEach(async () => {
    await seed([
      // A completa as três etapas na ordem.
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'add_to_cart', anonymousId: 'a', occurredAt: '2026-06-01T10:05:00Z' },
      { name: 'purchase', anonymousId: 'a', occurredAt: '2026-06-01T10:10:00Z' },

      // B para na segunda etapa.
      { name: 'page_view', anonymousId: 'b', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'add_to_cart', anonymousId: 'b', occurredAt: '2026-06-01T10:30:00Z' },

      // C só entra.
      { name: 'page_view', anonymousId: 'c', occurredAt: '2026-06-01T10:00:00Z' },

      // D comprou ANTES de entrar no funil: não pode contar como conversão.
      { name: 'purchase', anonymousId: 'd', occurredAt: '2026-06-01T09:00:00Z' },
      { name: 'page_view', anonymousId: 'd', occurredAt: '2026-06-01T10:00:00Z' },

      // E converteu fora da janela de 24h.
      { name: 'page_view', anonymousId: 'e', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'add_to_cart', anonymousId: 'e', occurredAt: '2026-06-04T10:00:00Z' },
    ]);
  });

  const range = { from: '2026-06-01T00:00:00Z', to: '2026-06-06T00:00:00Z' };

  it('conta apenas quem avançou na ordem certa e dentro da janela', async () => {
    const response = await report('funnel', {
      ...range,
      steps: 'page_view,add_to_cart,purchase',
      window: '24h',
    });

    const body = response.json<{ name: string; visitors: number }[]>();
    expect(body.map((step) => [step.name, step.visitors])).toEqual([
      ['page_view', 5], // a, b, c, d, e
      ['add_to_cart', 2], // a, b — e ficou fora da janela
      ['purchase', 1], // só a; a compra de d veio antes da entrada
    ]);
  });

  it('inclui quem estava fora da janela quando ela aumenta', async () => {
    const response = await report('funnel', {
      ...range,
      steps: 'page_view,add_to_cart',
      window: '7d',
    });

    expect(response.json<{ visitors: number }[]>()[1]!.visitors).toBe(3); // a, b, e
  });

  it('calcula conversão por etapa e acumulada', async () => {
    const response = await report('funnel', {
      ...range,
      steps: 'page_view,add_to_cart,purchase',
      window: '24h',
    });

    const body = response.json<{ stepRate: number | null; overallRate: number | null }[]>();
    expect(body[0]!.overallRate).toBe(100);
    expect(body[1]!.stepRate).toBe(40); // 2 de 5
    expect(body[2]!.stepRate).toBe(50); // 1 de 2
    expect(body[2]!.overallRate).toBe(20); // 1 de 5
  });

  it('mede a mediana de tempo desde a entrada no funil', async () => {
    const response = await report('funnel', {
      ...range,
      steps: 'page_view,add_to_cart',
      window: '24h',
    });

    // a levou 5 min, b levou 30 min — mediana de dois valores é a média deles.
    expect(response.json<{ medianSecondsFromEntry: number }[]>()[1]!.medianSecondsFromEntry).toBe(
      (300 + 1800) / 2,
    );
  });

  it('exige pelo menos duas etapas', async () => {
    const response = await report('funnel', { ...range, steps: 'page_view' });
    expect(response.statusCode).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe('retenção', () => {
  it('monta a matriz de coortes', async () => {
    await seed([
      // R1 aparece no dia 1 e volta nos dias 2 e 3.
      { name: 'page_view', anonymousId: 'r1', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'page_view', anonymousId: 'r1', occurredAt: '2026-06-02T10:00:00Z' },
      { name: 'page_view', anonymousId: 'r1', occurredAt: '2026-06-03T10:00:00Z' },
      // R2 aparece no dia 1 e nunca mais.
      { name: 'page_view', anonymousId: 'r2', occurredAt: '2026-06-01T11:00:00Z' },
    ]);

    const response = await report('retention', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      granularity: 'day',
      periods: '3',
    });

    const [cohort] = response.json<
      { cohort: string; size: number; periods: { period: number; retained: number; rate: number }[] }[]
    >();

    expect(cohort!.cohort).toBe('2026-06-01');
    expect(cohort!.size).toBe(2);
    expect(cohort!.periods).toEqual([
      { period: 0, retained: 2, rate: 100 },
      { period: 1, retained: 1, rate: 50 },
      { period: 2, retained: 1, rate: 50 },
    ]);
  });

  it('separa o evento que define a coorte do evento de retorno', async () => {
    await seed([
      { name: 'signup', anonymousId: 'r1', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'purchase', anonymousId: 'r1', occurredAt: '2026-06-02T10:00:00Z' },
      { name: 'signup', anonymousId: 'r2', occurredAt: '2026-06-01T10:00:00Z' },
    ]);

    const response = await report('retention', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      granularity: 'day',
      periods: '3',
      cohortEvent: 'signup',
      returnEvent: 'purchase',
    });

    const [cohort] = response.json<
      { size: number; periods: { period: number; retained: number; rate: number }[] }[]
    >();

    // A coorte é definida por quem se cadastrou; a retenção, por quem comprou.
    expect(cohort!.size).toBe(2);
    expect(cohort!.periods).toEqual([{ period: 1, retained: 1, rate: 50 }]);
  });
});

/* -------------------------------------------------------------------------- */

describe('visão geral', () => {
  it('compara o período com o anterior de mesma duração', async () => {
    await seed([
      // Período anterior (30/05): 1 evento.
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-05-31T10:00:00Z' },
      // Período atual (01/06): 3 eventos, 2 visitantes.
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' },
      { name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T11:00:00Z' },
      { name: 'page_view', anonymousId: 'b', occurredAt: '2026-06-01T12:00:00Z' },
    ]);

    const response = await report('overview', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
    });

    const body = response.json<{
      events: number;
      visitors: number;
      eventsPerVisitor: number;
      previous: { events: number };
      change: { events: number | null };
    }>();

    expect(body.events).toBe(3);
    expect(body.visitors).toBe(2);
    expect(body.eventsPerVisitor).toBe(1.5);
    expect(body.previous.events).toBe(1);
    expect(body.change.events).toBe(200); // de 1 para 3
  });

  it('devolve null na variação quando o período anterior foi zero', async () => {
    await seed([{ name: 'page_view', anonymousId: 'a', occurredAt: '2026-06-01T10:00:00Z' }]);

    const response = await report('overview', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
    });

    // Variação percentual sobre base zero é indefinida, não "infinito%".
    expect(response.json<{ change: { events: number | null } }>().change.events).toBeNull();
  });
});
