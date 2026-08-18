import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ingestBodySchema, ingestResponseSchema, type EventInput } from './ingest.schemas.js';
import { ingestEvents } from './ingest.service.js';
import { env } from '../../env.js';

export const ingestRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Limite próprio para ingestão.
   *
   * O limite global da API é pensado para um humano clicando num painel. Aqui a
   * origem legítima é um SDK: o teto é ordens de grandeza maior, e a contagem é
   * por chave de ingestão (não por IP), porque milhares de visitantes de um
   * mesmo site chegam pelo mesmo servidor do cliente.
   */
  await app.register(import('@fastify/rate-limit'), {
    max: env.INGEST_RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.headers.authorization ?? request.ip,
  });

  app.post(
    '/events',
    {
      onRequest: [app.authenticateApiKey],
      schema: {
        tags: ['Ingestão'],
        summary: 'Registra um evento ou um lote de eventos',
        description: [
          'Autenticado por chave de ingestão (`Authorization: Bearer bk_...`).',
          '',
          'Aceita um objeto de evento ou `{ "events": [...] }` com até',
          `${env.MAX_EVENTS_PER_BATCH} itens. Eventos com \`idempotencyKey\` já`,
          'usada no projeto são descartados em silêncio e contados em `duplicates`.',
        ].join('\n'),
        security: [{ apiKey: [] }],
        body: ingestBodySchema,
        response: { 202: ingestResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const batch: EventInput[] = 'events' in body ? body.events : [body];

      const result = await ingestEvents(request.ingestProjectId!, batch);

      // 202 e não 201: a API confirma o recebimento, mas o dado só aparece nos
      // relatórios pré-agregados depois do próximo rollup.
      return reply.status(202).send(result);
    },
  );
};
