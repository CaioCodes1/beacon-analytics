import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys, projects } from '../db/schema.js';
import { apiKeyMatches, apiKeyPrefixOf } from '../lib/credentials.js';
import { UnauthorizedError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { env } from '../env.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Exige um JWT válido do painel. */
    authenticateUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Exige uma chave de ingestão válida no header Authorization. */
    authenticateApiKey: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Garante que o projeto da rota pertence ao usuário autenticado. */
    requireProjectAccess: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    currentUser?: AuthenticatedUser;
    /** Preenchido pela autenticação por chave: todo insert é preso a este id. */
    ingestProjectId?: string;
    /** Preenchido por requireProjectAccess. */
    projectId?: string;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  app.decorateRequest('currentUser', undefined);
  app.decorateRequest('ingestProjectId', undefined);
  app.decorateRequest('projectId', undefined);

  app.decorate('authenticateUser', async (request: FastifyRequest) => {
    try {
      const payload = await request.jwtVerify<{ sub: string; email: string }>();
      request.currentUser = { id: payload.sub, email: payload.email };
    } catch {
      throw new UnauthorizedError('Token ausente, expirado ou inválido');
    }
  });

  /**
   * Autenticação de ingestão.
   *
   * O prefixo é indexado e único, então a busca é uma leitura de índice em vez
   * de uma varredura comparando hash linha a linha. Só depois de achar a linha
   * é que o segredo completo é verificado — e é essa segunda etapa que decide.
   */
  app.decorate('authenticateApiKey', async (request: FastifyRequest) => {
    const token = bearerToken(request);
    if (!token) throw new UnauthorizedError('Envie a chave de ingestão em Authorization: Bearer');

    const [record] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, apiKeyPrefixOf(token)), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (!record || !apiKeyMatches(token, record.keyHash)) {
      throw new UnauthorizedError('Chave de ingestão inválida ou revogada', 'INVALID_API_KEY');
    }

    request.ingestProjectId = record.projectId;

    // Registro de uso. Não bloqueia a resposta: se falhar, o evento continua
    // valendo — é telemetria, não regra de negócio.
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, record.id))
      .catch((error) => request.log.warn({ error }, 'falha ao registrar uso da chave'));
  });

  /**
   * Multi-tenancy.
   *
   * Nenhuma consulta de relatório recebe um `projectId` direto da URL sem
   * passar por aqui. É este passo que impede um usuário autenticado de ler os
   * dados de outra conta apenas trocando o id no path.
   */
  app.decorate('requireProjectAccess', async (request: FastifyRequest) => {
    const user = request.currentUser;
    if (!user) throw new UnauthorizedError();

    const { projectId } = request.params as { projectId?: string };
    if (!projectId) throw new ForbiddenError('Rota sem projeto definido');

    const [project] = await db
      .select({ id: projects.id, ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) throw new NotFoundError('Projeto não encontrado', 'PROJECT_NOT_FOUND');
    if (project.ownerId !== user.id) {
      // 404 em vez de 403 de propósito: responder "existe, mas não é seu"
      // confirma a existência de um recurso de outra conta.
      throw new NotFoundError('Projeto não encontrado', 'PROJECT_NOT_FOUND');
    }

    request.projectId = project.id;
  });
});
