import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';
import { env } from '../env.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Um único lugar traduz exceção em resposta HTTP.
 *
 * Sem isso, cada rota acaba com seu próprio try/catch e o formato do erro varia
 * de endpoint para endpoint — que é exatamente o que quebra quem consome a API.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error, request, reply) => {
    // Falha de validação de schema declarado na rota.
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Requisição inválida',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
        },
      } satisfies ErrorBody);
    }

    // Falha de validação feita dentro de um service.
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Requisição inválida',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      } satisfies ErrorBody);
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      } satisfies ErrorBody);
    }

    // A partir daqui o erro não é de nenhum tipo conhecido da aplicação: pode
    // vir do Fastify, do driver do Postgres ou de qualquer dependência.
    const unknownError = error as { statusCode?: number; code?: string; message?: string };

    if (unknownError.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Muitas requisições. Tente novamente em instantes.' },
      } satisfies ErrorBody);
    }

    // Timeout de statement do Postgres: a consulta é pesada demais, não é um
    // bug do servidor. Vale avisar o cliente para reduzir o intervalo.
    if (unknownError.code === '57014') {
      return reply.status(400).send({
        error: {
          code: 'QUERY_TIMEOUT',
          message: 'A consulta excedeu o tempo limite. Reduza o intervalo de datas ou os filtros.',
        },
      } satisfies ErrorBody);
    }

    request.log.error({ err: error }, 'erro não tratado');

    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Erro interno do servidor',
        // Detalhe da exceção só vaza fora de produção.
        details: env.NODE_ENV === 'production' ? undefined : unknownError.message,
      },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Rota não encontrada: ${request.method} ${request.url}`,
      },
    } satisfies ErrorBody);
  });
});
