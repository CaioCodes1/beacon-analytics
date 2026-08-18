import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerUser, authenticateUser } from './auth.service.js';

const publicUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.date(),
});

const credentialsSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(8, 'A senha precisa ter no mínimo 8 caracteres').max(72),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/register',
    {
      schema: {
        tags: ['Autenticação'],
        summary: 'Cria uma conta',
        body: credentialsSchema.extend({
          name: z.string().min(2, 'Informe seu nome').max(120),
        }),
        response: {
          201: z.object({ user: publicUserSchema, token: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const user = await registerUser(request.body);
      const token = app.jwt.sign({ sub: user.id, email: user.email });
      return reply.status(201).send({ user, token });
    },
  );

  app.post(
    '/login',
    {
      schema: {
        tags: ['Autenticação'],
        summary: 'Autentica e devolve um JWT',
        body: credentialsSchema,
        response: {
          200: z.object({ user: publicUserSchema, token: z.string() }),
        },
      },
    },
    async (request) => {
      const user = await authenticateUser(request.body);
      const token = app.jwt.sign({ sub: user.id, email: user.email });
      return { user, token };
    },
  );

  app.get(
    '/me',
    {
      onRequest: [app.authenticateUser],
      schema: {
        tags: ['Autenticação'],
        summary: 'Dados do usuário do token',
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ id: z.string(), email: z.string() }) },
      },
    },
    async (request) => ({
      id: request.currentUser!.id,
      email: request.currentUser!.email,
    }),
  );
};
