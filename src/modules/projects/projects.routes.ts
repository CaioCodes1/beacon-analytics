import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createProject,
  listProjects,
  deleteProject,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from './projects.service.js';

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.date(),
});

const projectParams = z.object({ projectId: z.string().uuid() });

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  // Tudo abaixo exige um usuário autenticado.
  app.addHook('onRequest', app.authenticateUser);

  app.post(
    '/',
    {
      schema: {
        tags: ['Projetos'],
        summary: 'Cria um projeto',
        security: [{ bearerAuth: [] }],
        body: z.object({ name: z.string().min(2).max(120) }),
        response: { 201: projectSchema },
      },
    },
    async (request, reply) => {
      const project = await createProject(request.currentUser!.id, request.body.name);
      return reply.status(201).send(project);
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['Projetos'],
        summary: 'Lista os projetos da conta',
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(projectSchema) },
      },
    },
    async (request) => listProjects(request.currentUser!.id),
  );

  app.delete(
    '/:projectId',
    {
      schema: {
        tags: ['Projetos'],
        summary: 'Remove um projeto e todos os seus eventos',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await deleteProject(request.currentUser!.id, request.params.projectId);
      return reply.status(204).send(null);
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Chaves de ingestão                                                     */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/:projectId/keys',
    {
      onRequest: [app.authenticateUser, app.requireProjectAccess],
      schema: {
        tags: ['Projetos'],
        summary: 'Cria uma chave de ingestão',
        description:
          'O valor da chave aparece apenas nesta resposta. O banco guarda só o hash.',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        body: z.object({ name: z.string().min(2).max(80) }),
        response: {
          201: z.object({
            id: z.string().uuid(),
            name: z.string(),
            prefix: z.string(),
            key: z.string().describe('Guarde agora — não será exibida novamente'),
            createdAt: z.date(),
          }),
        },
      },
    },
    async (request, reply) => {
      const key = await createApiKey(request.projectId!, request.body.name);
      return reply.status(201).send(key);
    },
  );

  app.get(
    '/:projectId/keys',
    {
      onRequest: [app.authenticateUser, app.requireProjectAccess],
      schema: {
        tags: ['Projetos'],
        summary: 'Lista as chaves do projeto',
        security: [{ bearerAuth: [] }],
        params: projectParams,
        response: {
          200: z.array(
            z.object({
              id: z.string().uuid(),
              name: z.string(),
              prefix: z.string(),
              lastUsedAt: z.date().nullable(),
              revokedAt: z.date().nullable(),
              createdAt: z.date(),
            }),
          ),
        },
      },
    },
    async (request) => listApiKeys(request.projectId!),
  );

  app.delete(
    '/:projectId/keys/:keyId',
    {
      onRequest: [app.authenticateUser, app.requireProjectAccess],
      schema: {
        tags: ['Projetos'],
        summary: 'Revoga uma chave',
        security: [{ bearerAuth: [] }],
        params: projectParams.extend({ keyId: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await revokeApiKey(request.projectId!, request.params.keyId);
      return reply.status(204).send(null);
    },
  );
};
