import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/**
 * `TRUNCATE ... CASCADE` em vez de `DELETE`: não gera tuplas mortas, não precisa
 * de vacuum e reinicia as sequências, deixando cada teste com ids previsíveis.
 */
export async function resetDatabase(): Promise<void> {
  await pool.query(
    'TRUNCATE events, daily_event_rollup, api_keys, projects, users RESTART IDENTITY CASCADE',
  );
}

export interface TestAccount {
  token: string;
  userId: string;
  projectId: string;
  apiKey: string;
}

/** Cria conta + projeto + chave de ingestão pela própria API, como um cliente faria. */
export async function createAccount(
  app: FastifyInstance,
  email = 'teste@beacon.dev',
): Promise<TestAccount> {
  const registered = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { name: 'Pessoa de Teste', email, password: 'senha-forte-123' },
  });

  const { token, user } = registered.json<{ token: string; user: { id: string } }>();

  const project = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Projeto de Teste' },
  });

  const { id: projectId } = project.json<{ id: string }>();

  const key = await app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/keys`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Chave de Teste' },
  });

  return {
    token,
    userId: user.id,
    projectId,
    apiKey: key.json<{ key: string }>().key,
  };
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
