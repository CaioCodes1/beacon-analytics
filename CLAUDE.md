# beacon-analytics

API de analytics de produto: recebe eventos de aplicações clientes e devolve
relatórios agregados (overview, série temporal, breakdown, funil, retenção).
É o projeto mais recente do workspace (14/08/2026) e o único em TypeScript.

**O ponto do projeto é SQL analítico sobre volume real** — funções de janela,
`date_trunc` com fuso, pré-agregação. O seed gera ~2 milhões de eventos de
propósito: em base de brinquedo nenhuma otimização se justifica.

## Stack

Node 20+ · TypeScript (ESM) · Fastify 5 · PostgreSQL 16 · Drizzle ORM ·
Zod (via `fastify-type-provider-zod`) · Vitest · Docker Compose · GitHub Actions

## Estrutura

```
src/
  server.ts          sobe o processo          app.ts  monta a aplicação
  env.ts             valida .env com Zod — não sobe com config inválida
  db/                schema.ts (Drizzle), migrate.ts, migrations/*.sql
  plugins/           auth.ts (JWT + API key), error-handler.ts
  lib/               credentials.ts, errors.ts
  modules/
    auth/            register, login, me
    projects/        CRUD de projetos + gestão de API keys
    ingest/          POST /v1/events  (autenticado por API key `bk_`)
    reports/         reports.queries.ts é o coração: todo o SQL analítico
scripts/             seed.ts (~2M eventos/90 dias), bench.ts, rollup.ts
tests/               integração contra Postgres real (auth, ingest, reports)
docs/                DATABASE.md (por que o schema é assim), PERFORMANCE.md
```

## Modelo de dados

```
users ──< projects ──< api_keys
                  ├──< events              (tabela de fatos, cresce sem limite)
                  └──< daily_event_rollup  (pré-agregação derivada de events)
```

`events` é híbrida: dimensões conhecidas em colunas (`name`, `occurred_at`,
`anonymous_id`, `path`, `country`, `device`…) e o resto em `properties jsonb`.
Nem tudo em coluna (cada campo novo viraria migration), nem tudo em JSONB
(agrupar exigiria extrair e converter texto linha a linha). Detalhes e
trade-offs em [docs/DATABASE.md](docs/DATABASE.md).

## Autenticação — dois caminhos distintos

| Quem | Como | Onde |
|---|---|---|
| Painel/usuário | JWT (`/v1/auth/login`) | rotas de projects e reports |
| Aplicação cliente | API key com prefixo `bk_` | `POST /v1/events` |

## Endpoints

```
POST   /v1/auth/register | /login          GET /v1/auth/me
GET|POST /v1/projects    GET|DELETE /v1/projects/:projectId
POST|GET|DELETE /v1/projects/:projectId/keys[/:keyId]
POST   /v1/events                          ← ingestão (API key)
GET    /v1/projects/:projectId/reports/overview
                                  /timeseries  /breakdown  /funnel  /retention
POST   /v1/projects/:projectId/rollup      ← recalcula a pré-agregação
GET    /docs                               ← Scalar sobre o OpenAPI do Fastify
```

## Comandos

```bash
npm run docker:up      # Postgres 16 na porta 5433
npm run db:migrate
npm run db:seed        # ~2.000.000 de eventos, 25 mil visitantes, 90 dias
npm run dev            # tsx watch, porta 3333
npm run bench          # mediana de 5 execuções + EXPLAIN (ANALYZE, BUFFERS)
npm test               # Vitest, integração contra Postgres real
npm run typecheck
```

Os testes rodam em **fork único, sem paralelismo** (`vitest.config.ts`): eles
compartilham o mesmo banco e um truncaria a tabela enquanto o outro consulta.
O banco de teste é `beacon_test` na 5433. O CI (`.github/workflows/ci.yml`) sobe
um Postgres 16 de serviço — não mocka o banco, porque é justamente o banco que
está sendo testado.

## Estado / pendências

- README escrito em 18/08/2026 (era a pendência mais visível). Código, testes,
  docs técnicos, Dockerfile e CI já estavam completos.
- **Ainda não tem repositório git** — é o único projeto do workspace sem `.git`;
  nada foi commitado até hoje.
- A tabela de resultados de `docs/PERFORMANCE.md` está com `_a medir_`: o
  `npm run bench` nunca rodou sobre a massa do seed. Depende de Node e Docker
  disponíveis na máquina.
