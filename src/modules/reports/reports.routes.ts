import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  timeseriesQuerySchema,
  breakdownQuerySchema,
  funnelQuerySchema,
  retentionQuerySchema,
  reportFiltersSchema,
} from './reports.schemas.js';
import {
  overview,
  timeseries,
  breakdown,
  funnel,
  retention,
  refreshRollup,
} from './reports.queries.js';

const projectParams = z.object({ projectId: z.string().uuid() });

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  // Autenticação e escopo de projeto valem para todas as rotas deste módulo.
  app.addHook('onRequest', app.authenticateUser);
  app.addHook('onRequest', app.requireProjectAccess);

  app.get(
    '/:projectId/reports/overview',
    {
      schema: {
        tags: ['Relatórios'],
        summary: 'KPIs do período com comparação contra o período anterior',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        querystring: reportFiltersSchema,
        response: {
          200: z.object({
            events: z.number(),
            visitors: z.number(),
            sessions: z.number(),
            eventsPerVisitor: z.number(),
            previous: z.object({
              events: z.number(),
              visitors: z.number(),
              sessions: z.number(),
            }),
            change: z.object({
              events: z.number().nullable(),
              visitors: z.number().nullable(),
              sessions: z.number().nullable(),
            }),
          }),
        },
      },
    },
    async (request) => overview({ ...request.query, projectId: request.projectId! }),
  );

  app.get(
    '/:projectId/reports/timeseries',
    {
      schema: {
        tags: ['Relatórios'],
        summary: 'Série temporal com lacunas preenchidas',
        description:
          'O campo `source` informa se a resposta veio da pré-agregação diária ' +
          '(`rollup`) ou da tabela de eventos (`raw`).',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        querystring: timeseriesQuerySchema,
        response: {
          200: z.object({
            interval: z.string(),
            metric: z.string(),
            timezone: z.string(),
            source: z.enum(['rollup', 'raw']),
            points: z.array(
              z.object({
                bucket: z.string(),
                events: z.number(),
                visitors: z.number(),
                sessions: z.number(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => timeseries({ ...request.query, projectId: request.projectId! }),
  );

  app.get(
    '/:projectId/reports/breakdown',
    {
      schema: {
        tags: ['Relatórios'],
        summary: 'Top N de uma dimensão, com a cauda somada em "Outros"',
        description:
          'Dimensões: event, path, country, device, browser, os, referrer ou ' +
          '`prop:<chave>` para uma propriedade customizada.',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        querystring: breakdownQuerySchema,
        response: {
          200: z.array(
            z.object({
              value: z.string(),
              events: z.number(),
              visitors: z.number().nullable(),
              share: z.number().nullable(),
            }),
          ),
        },
      },
    },
    async (request) => breakdown({ ...request.query, projectId: request.projectId! }),
  );

  app.get(
    '/:projectId/reports/funnel',
    {
      schema: {
        tags: ['Relatórios'],
        summary: 'Conversão por etapa, respeitando ordem e janela de tempo',
        description: 'Ex.: `?steps=page_view,add_to_cart,purchase&window=24h`',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        querystring: funnelQuerySchema,
        response: {
          200: z.array(
            z.object({
              step: z.number(),
              name: z.string(),
              visitors: z.number(),
              stepRate: z.number().nullable(),
              overallRate: z.number().nullable(),
              medianSecondsFromEntry: z.number(),
            }),
          ),
        },
      },
    },
    async (request) => funnel({ ...request.query, projectId: request.projectId! }),
  );

  app.get(
    '/:projectId/reports/retention',
    {
      schema: {
        tags: ['Relatórios'],
        summary: 'Matriz de retenção por coorte',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        querystring: retentionQuerySchema,
        response: {
          200: z.array(
            z.object({
              cohort: z.string(),
              size: z.number(),
              periods: z.array(
                z.object({
                  period: z.number(),
                  retained: z.number(),
                  rate: z.number(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (request) => retention({ ...request.query, projectId: request.projectId! }),
  );

  app.post(
    '/:projectId/rollup',
    {
      schema: {
        tags: ['Relatórios'],
        summary: 'Recalcula a pré-agregação diária de um intervalo',
        description:
          'Idempotente: pode rodar quantas vezes for preciso. Em produção o ' +
          'mesmo trabalho é feito por `npm run db:rollup` num agendador.',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        body: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
        response: { 200: z.object({ rowsWritten: z.number() }) },
      },
    },
    async (request) => {
      const rowsWritten = await refreshRollup(
        request.projectId!,
        request.body.from,
        request.body.to,
      );
      return { rowsWritten };
    },
  );
};
