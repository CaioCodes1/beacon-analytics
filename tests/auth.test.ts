import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, resetDatabase, createAccount, auth } from './helpers.js';
import { closeDatabase } from '../src/db/index.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

beforeEach(resetDatabase);

describe('autenticação', () => {
  it('registra uma conta e devolve um token utilizável', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Ana', email: 'ana@exemplo.com', password: 'senha-forte-123' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ token: string; user: { email: string } }>();
    expect(body.user.email).toBe('ana@exemplo.com');

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(body.token) });
    expect(me.statusCode).toBe(200);
  });

  it('normaliza o e-mail em minúsculas', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Ana', email: 'Ana@Exemplo.COM', password: 'senha-forte-123' },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ana@exemplo.com', password: 'senha-forte-123' },
    });

    expect(login.statusCode).toBe(200);
  });

  it('recusa e-mail duplicado', async () => {
    const payload = { name: 'Ana', email: 'ana@exemplo.com', password: 'senha-forte-123' };
    await app.inject({ method: 'POST', url: '/v1/auth/register', payload });
    const second = await app.inject({ method: 'POST', url: '/v1/auth/register', payload });

    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('EMAIL_TAKEN');
  });

  it('recusa senha curta na validação, sem tocar o banco', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Ana', email: 'ana@exemplo.com', password: '123' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('devolve a mesma resposta para senha errada e para e-mail inexistente', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Ana', email: 'ana@exemplo.com', password: 'senha-forte-123' },
    });

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ana@exemplo.com', password: 'senha-errada-123' },
    });

    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ninguem@exemplo.com', password: 'senha-forte-123' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Nem o status nem o corpo podem distinguir os dois casos: a diferença
    // revelaria quais e-mails estão cadastrados.
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('bloqueia rota protegida sem token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(response.statusCode).toBe(401);
  });
});

describe('isolamento entre contas', () => {
  it('esconde o projeto de outra conta com 404, não com 403', async () => {
    const owner = await createAccount(app, 'dono@exemplo.com');
    const intruder = await createAccount(app, 'intruso@exemplo.com');

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${owner.projectId}/keys`,
      headers: auth(intruder.token),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('chaves de ingestão', () => {
  it('mostra a chave uma única vez e guarda só o hash', async () => {
    const account = await createAccount(app);

    expect(account.apiKey.startsWith('bk_')).toBe(true);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/projects/${account.projectId}/keys`,
      headers: auth(account.token),
    });

    const keys = listed.json<{ prefix: string }[]>();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.prefix).toBe(account.apiKey.slice(0, 11));
    // O valor completo não aparece em lugar nenhum da listagem.
    expect(JSON.stringify(keys)).not.toContain(account.apiKey);
  });

  it('rejeita ingestão com chave revogada', async () => {
    const account = await createAccount(app);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/projects/${account.projectId}/keys`,
      headers: auth(account.token),
    });
    const keyId = listed.json<{ id: string }[]>()[0]!.id;

    await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${account.projectId}/keys/${keyId}`,
      headers: auth(account.token),
    });

    const ingest = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: auth(account.apiKey),
      payload: { name: 'page_view', anonymousId: 'anon_1' },
    });

    expect(ingest.statusCode).toBe(401);
    expect(ingest.json<{ error: { code: string } }>().error.code).toBe('INVALID_API_KEY');
  });
});
