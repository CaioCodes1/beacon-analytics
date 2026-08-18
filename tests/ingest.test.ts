import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
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

function ingest(payload: unknown, key = account.apiKey) {
  return app.inject({ method: 'POST', url: '/v1/events', headers: auth(key), payload });
}

describe('ingestão de eventos', () => {
  it('aceita um evento avulso', async () => {
    const response = await ingest({ name: 'page_view', anonymousId: 'anon_1', path: '/' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ received: 1, accepted: 1, duplicates: 0 });
  });

  it('aceita um lote', async () => {
    const response = await ingest({
      events: [
        { name: 'page_view', anonymousId: 'anon_1' },
        { name: 'product_view', anonymousId: 'anon_1' },
        { name: 'page_view', anonymousId: 'anon_2' },
      ],
    });

    expect(response.json()).toEqual({ received: 3, accepted: 3, duplicates: 0 });
  });

  it('preenche occurredAt com o horário do servidor quando ausente', async () => {
    await ingest({ name: 'page_view', anonymousId: 'anon_1' });

    const [row] = await db.select().from(events).where(eq(events.projectId, account.projectId));
    expect(row!.occurredAt).toBeInstanceOf(Date);
    expect(Date.now() - row!.occurredAt.getTime()).toBeLessThan(60_000);
  });

  it('descarta reenvios com a mesma idempotencyKey', async () => {
    const payload = {
      name: 'purchase',
      anonymousId: 'anon_1',
      idempotencyKey: 'pedido-12345678',
    };

    const first = await ingest(payload);
    const second = await ingest(payload);

    expect(first.json()).toEqual({ received: 1, accepted: 1, duplicates: 0 });
    expect(second.json()).toEqual({ received: 1, accepted: 0, duplicates: 1 });

    const stored = await db.select().from(events).where(eq(events.projectId, account.projectId));
    expect(stored).toHaveLength(1);
  });

  it('deduplica dentro do mesmo lote', async () => {
    const response = await ingest({
      events: [
        { name: 'purchase', anonymousId: 'anon_1', idempotencyKey: 'pedido-12345678' },
        { name: 'purchase', anonymousId: 'anon_1', idempotencyKey: 'pedido-12345678' },
      ],
    });

    expect(response.json()).toEqual({ received: 2, accepted: 1, duplicates: 1 });
  });

  it('trata a idempotência por projeto, não globalmente', async () => {
    const other = await createAccount(app, 'outro@exemplo.com');
    const payload = { name: 'purchase', anonymousId: 'anon_1', idempotencyKey: 'pedido-12345678' };

    await ingest(payload);
    const response = await ingest(payload, other.apiKey);

    // A mesma chave em outro projeto é um evento diferente, não uma repetição.
    expect(response.json()).toEqual({ received: 1, accepted: 1, duplicates: 0 });
  });

  it('rejeita evento sem anonymousId', async () => {
    const response = await ingest({ name: 'page_view' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejeita propriedades aninhadas', async () => {
    const response = await ingest({
      name: 'page_view',
      anonymousId: 'anon_1',
      properties: { pedido: { id: 1 } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejeita lote acima do limite configurado', async () => {
    const response = await ingest({
      events: Array.from({ length: 501 }, (_, index) => ({
        name: 'page_view',
        anonymousId: `anon_${index}`,
      })),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('BATCH_TOO_LARGE');
  });

  it('limita ao horário atual um evento com data no futuro', async () => {
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const response = await ingest({
      name: 'page_view',
      anonymousId: 'anon_1',
      occurredAt: future.toISOString(),
    });

    // O lote não pode ser perdido por causa de um relógio desregulado.
    expect(response.statusCode).toBe(202);
    const [row] = await db.select().from(events).where(eq(events.projectId, account.projectId));
    expect(row!.occurredAt.getTime()).toBeLessThan(future.getTime());
  });

  it('exige chave de ingestão', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { name: 'page_view', anonymousId: 'anon_1' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('grava o evento no projeto da chave, ignorando qualquer projectId enviado', async () => {
    const other = await createAccount(app, 'outro@exemplo.com');

    await ingest({ name: 'page_view', anonymousId: 'anon_1', projectId: other.projectId } as never);

    const mine = await db.select().from(events).where(eq(events.projectId, account.projectId));
    const theirs = await db.select().from(events).where(eq(events.projectId, other.projectId));

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});
