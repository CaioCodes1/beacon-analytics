import { db } from '../../db/index.js';
import { events, type NewEvent } from '../../db/schema.js';
import { BadRequestError } from '../../lib/errors.js';
import { env } from '../../env.js';
import type { EventInput } from './ingest.schemas.js';

export interface IngestResult {
  received: number;
  accepted: number;
  duplicates: number;
}

/**
 * Grava um lote de eventos.
 *
 * Duas decisões dominam esta função:
 *
 * 1. **Um único INSERT com N linhas**, não N inserts. Cada round-trip ao banco
 *    custa mais que a gravação em si; um lote de 500 eventos em 500 comandos
 *    passa a maior parte do tempo esperando a rede. Em uma linha só, o custo
 *    vira praticamente o da escrita.
 *
 * 2. **ON CONFLICT DO NOTHING** em cima do índice único parcial de
 *    `idempotency_key`. A alternativa — consultar antes o que já existe e
 *    inserir o resto — tem uma janela de corrida entre a leitura e a escrita:
 *    dois lotes simultâneos com a mesma chave passariam os dois pela
 *    verificação. Deixar o banco resolver no índice elimina a janela.
 */
export async function ingestEvents(
  projectId: string,
  input: EventInput[],
): Promise<IngestResult> {
  if (input.length > env.MAX_EVENTS_PER_BATCH) {
    throw new BadRequestError(
      `O lote excede o limite de ${env.MAX_EVENTS_PER_BATCH} eventos`,
      'BATCH_TOO_LARGE',
    );
  }

  const now = new Date();

  const rows: NewEvent[] = input.map((event) => ({
    projectId,
    name: event.name,
    occurredAt: event.occurredAt ?? now,
    receivedAt: now,
    anonymousId: event.anonymousId,
    userId: event.userId ?? null,
    sessionId: event.sessionId ?? null,
    path: event.path ?? null,
    referrer: event.referrer ?? null,
    country: event.country ?? null,
    device: event.device ?? null,
    browser: event.browser ?? null,
    os: event.os ?? null,
    properties: event.properties,
    idempotencyKey: event.idempotencyKey ?? null,
  }));

  /**
   * Um evento com data no futuro violaria a CHECK constraint e derrubaria o
   * lote inteiro. Como relógio de cliente é notoriamente não confiável,
   * a data é limitada aqui em vez de rejeitar a requisição: perder a precisão
   * de um timestamp é melhor que descartar 499 eventos válidos por causa de um.
   */
  const ceiling = new Date(now.getTime() + 30 * 60 * 1000);
  for (const row of rows) {
    if (row.occurredAt > ceiling) row.occurredAt = now;
  }

  const inserted = await db
    .insert(events)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: events.id });

  return {
    received: rows.length,
    accepted: inserted.length,
    duplicates: rows.length - inserted.length,
  };
}
