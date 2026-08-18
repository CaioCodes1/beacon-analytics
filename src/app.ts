import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { projectRoutes } from './modules/projects/projects.routes.js';
import { ingestRoutes } from './modules/ingest/ingest.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { pool } from './db/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
          : undefined,
    },
    // Um lote de 500 eventos com propriedades customizadas passa folgado do
    // limite padrão de 1MB.
    bodyLimit: 4 * 1024 * 1024,
    // Sem isso, um proxy mal configurado deixaria o rate limit contar todo o
    // tráfego como vindo de um IP só.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  // Um único par de compiladores faz o Zod valer para entrada, saída e OpenAPI:
  // o schema da rota é a fonte única de verdade, sem duplicar tipos.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Beacon Analytics API',
        description:
          'Ingestão de eventos de produto e relatórios agregados sobre eles.\n\n' +
          'A ingestão usa chave de projeto (`Authorization: Bearer bk_...`); ' +
          'os relatórios usam o JWT devolvido no login.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'Chave de ingestão do projeto (prefixo `bk_`)',
          },
        },
      },
      tags: [
        { name: 'Autenticação', description: 'Contas e tokens do painel' },
        { name: 'Projetos', description: 'Projetos e chaves de ingestão' },
        { name: 'Ingestão', description: 'Recebimento de eventos' },
        { name: 'Relatórios', description: 'Consultas agregadas' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(scalar, { routePrefix: '/docs' });

  await app.register(authPlugin);

  app.get(
    '/health',
    { schema: { tags: ['Sistema'], summary: 'Verificação de saúde', hide: true } },
    async (_request, reply) => {
      // Saúde de verdade é "consigo falar com o banco", não "o processo subiu".
      try {
        await pool.query('SELECT 1');
        return { status: 'ok', database: 'up' };
      } catch {
        return reply.status(503).send({ status: 'degraded', database: 'down' });
      }
    },
  );

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(projectRoutes, { prefix: '/v1/projects' });
  await app.register(reportRoutes, { prefix: '/v1/projects' });
  await app.register(ingestRoutes, { prefix: '/v1' });

  return app;
}
