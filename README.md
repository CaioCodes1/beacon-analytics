# Beacon Analytics

API de analytics de produto: recebe eventos de aplicações clientes e responde
perguntas sobre eles — quantos visitantes únicos, como a conversão caiu ao longo
do funil, quantos voltaram na semana seguinte.

<p>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" />
  <img alt="Drizzle" src="https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=black" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

> **A ideia central do projeto:** a parte difícil de analytics não é guardar
> evento — é responder pergunta agregada sobre milhões deles sem que o usuário
> desista de esperar. Por isso o seed gera **2 milhões de eventos**: em base de
> brinquedo toda consulta responde em milissegundos, todo plano de execução
> parece bom e nenhuma decisão de índice se justifica.

---

## Sumário

- [O problema](#o-problema)
- [A solução](#a-solução)
- [Stack](#stack)
- [Arquitetura](#arquitetura)
- [Banco de dados](#banco-de-dados)
- [Autenticação — dois caminhos](#autenticação--dois-caminhos)
- [Ingestão](#ingestão)
- [Relatórios](#relatórios)
- [Endpoints](#endpoints)
- [Exemplos de uso](#exemplos-de-uso)
- [Como executar](#como-executar)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Testes](#testes)
- [Dependências e segurança](#dependências-e-segurança)
- [Performance](#performance)
- [Decisões e trade-offs](#decisões-e-trade-offs)
- [Melhorias futuras](#melhorias-futuras)

---

## O problema

Um produto quer saber o que os usuários fazem dentro dele. As saídas comuns têm
custos que aparecem depois:

| Caminho | O que dá errado |
|---|---|
| Ferramenta pronta (GA e afins) | Os dados brutos não são seus; amostragem em volume alto; pergunta fora do padrão não tem resposta |
| `console.log` + planilha | Não escala, não agrega, não sobrevive a um mês de tráfego |
| Guardar tudo e consultar na hora | Funciona com dez mil linhas. Com dez milhões, o relatório do painel vira um timeout |

O terceiro é o interessante, porque é onde estão as decisões de verdade: qual
índice, qual pré-agregação, o que rejeitar antes de chegar ao banco.

## A solução

Uma API com duas metades bem separadas:

**Ingestão** — um endpoint que aceita lotes de eventos de qualquer aplicação,
autenticado por chave de API, idempotente e barato por evento.

**Relatórios** — cinco consultas agregadas sobre esses eventos, todas filtráveis
pelas mesmas dimensões e por propriedades customizadas, com o SQL analítico
concentrado num arquivo só (`src/modules/reports/reports.queries.ts`).

---

## Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Runtime | Node 22+, TypeScript, ESM | Tipos onde mais importam: no formato dos eventos e dos filtros |
| HTTP | Fastify 5 | O schema faz parte da rota — a mesma definição valida a requisição e gera o OpenAPI |
| Validação | Zod, via `fastify-type-provider-zod` | Um schema só; `request.query` já chega tipado no handler |
| Banco | PostgreSQL 16 | Funções de janela, `date_trunc` com fuso, JSONB com índice GIN |
| Acesso a dados | Drizzle ORM | Tipagem do schema sem esconder o SQL: os relatórios são SQL escrito à mão |
| Docs | `@fastify/swagger` + Scalar | Referência viva em `/docs`, derivada dos schemas |
| Testes | Vitest contra Postgres real | Mockar o banco invalidaria justamente o que se quer testar |

---

## Arquitetura

```
requisição
   │
   ├─ plugins/auth.ts ............ JWT (painel) ou chave bk_ (ingestão)
   ├─ modules/<x>/routes.ts ...... schema Zod: valida a entrada e descreve a saída
   ├─ modules/<x>/service.ts ..... regra de negócio, sem saber que existe HTTP
   ├─ modules/reports/queries.ts . o SQL analítico
   └─ plugins/error-handler.ts ... erro tipado → resposta JSON consistente
```

`src/app.ts` monta a aplicação e registra plugins e rotas; `src/server.ts` só
escuta a porta. É essa separação que permite os testes subirem a API sem ocupar
porta.

`src/env.ts` valida o `.env` com Zod no start: **o processo não sobe com
configuração inválida**, em vez de quebrar na primeira requisição que usar a
variável faltante.

---

## Banco de dados

```
users ──< projects ──< api_keys
                  │
                  ├──< events                (tabela de fatos, cresce sem limite)
                  └──< daily_event_rollup    (pré-agregação derivada de events)
```

`users`, `projects` e `api_keys` são cadastro: milhares de linhas no máximo.
`events` é de outra natureza — é ela que dita todas as decisões técnicas.

### O modelo híbrido da tabela de eventos

```sql
name, occurred_at, anonymous_id, user_id, session_id,
path, referrer, country, device, browser, os,   -- dimensões conhecidas
properties jsonb                                -- o resto
```

As duas saídas óbvias são ruins: **tudo em coluna** faz de cada campo novo que um
cliente quer enviar uma migration; **tudo em JSONB** transforma "agrupar por
país" em extrair e converter texto a cada linha, sem tipo, sem `CHECK` e com
índice maior e mais lento.

O detalhamento de cada tabela, índice e constraint está em
[docs/DATABASE.md](docs/DATABASE.md).

---

## Autenticação — dois caminhos

| Quem | Como | Onde |
|---|---|---|
| Pessoa no painel | JWT via `/v1/auth/login` | projetos, chaves e relatórios |
| Aplicação cliente | Chave `bk_…` no header | `POST /v1/events` |

**Senha usa bcrypt; chave de API usa SHA-256.** Não é inconsistência. Bcrypt é
lento de propósito porque senha humana tem pouca entropia e cada tentativa de
adivinhação precisa custar caro ao atacante. Uma chave aqui tem 256 bits vindos
do CSPRNG do sistema — não existe dicionário para isso, e como ela é verificada
em *toda* requisição de ingestão, bcrypt custaria ~100 ms de CPU por evento
recebido e viraria o gargalo da API inteira. SHA-256 com comparação em tempo
constante é a escolha certa para segredo de alta entropia. A regra não é "bcrypt
sempre", é **trabalho proporcional à fraqueza do segredo**.

A chave em claro aparece **uma única vez**, na resposta da criação. Depois resta
só o prefixo visível, para o usuário saber qual chave é qual.

---

## Ingestão

`POST /v1/events` aceita um evento ou um lote (`{ "events": [...] }`), até
`MAX_EVENTS_PER_BATCH` (500 por padrão).

Três decisões que valem por todo o endpoint:

**Um `INSERT` com N linhas, não N inserts.** Cada ida ao banco custa mais que a
gravação em si; 500 comandos separados passam a maior parte do tempo esperando
rede.

**Deduplicação por `ON CONFLICT DO NOTHING`** sobre o índice único parcial de
`idempotency_key`. A alternativa — consultar antes o que já existe e inserir o
resto — tem uma janela de corrida entre ler e escrever: dois lotes simultâneos
com a mesma chave passariam os dois pela verificação. Deixar o índice decidir
elimina a janela. Um SDK que reenvia por falha de rede manda a mesma chave, e o
banco descarta a segunda gravação sem erro.

**Relógio de cliente não é confiável.** Evento com data mais de 30 minutos no
futuro tem a data ajustada para agora, em vez de derrubar o lote inteiro na
`CHECK` constraint: perder a precisão de um timestamp é melhor que descartar 499
eventos válidos por causa de um.

A resposta diz exatamente o que aconteceu: `received`, `accepted`, `duplicates`.

Valor de propriedade customizada é **escalar** (string, número, booleano ou
nulo). Aceitar objeto aninhado parece generoso, mas significa aceitar documento
de profundidade arbitrária na tabela que mais cresce — e nenhum relatório sabe
agrupar por um objeto.

---

## Relatórios

Todos aceitam o mesmo conjunto de filtros — `from`, `to`, `timezone` (nome IANA,
validado contra o runtime), `event`, `path`, `country`, `device`, `browser`, `os`
e `properties` (JSON, aplicado com o operador de contenção `@>`, o único coberto
pelo índice GIN `jsonb_path_ops`).

| Relatório | Responde | Parâmetros próprios |
|---|---|---|
| `overview` | KPIs do período **e do período anterior de mesma duração**, com a variação — um número sozinho não diz nada, a variação diz | — |
| `timeseries` | Evolução ao longo do tempo | `interval` (hour/day/week/month), `metric` (events/visitors/sessions) |
| `breakdown` | Ranking por dimensão | `dimension`, `limit` (≤ 100) |
| `funnel` | Quantos passaram por cada etapa, na ordem | `steps` (2 a 8), `window` (ex.: `24h`, `7d`) |
| `retention` | Coortes: quantos voltaram depois | `granularity` (day/week), `periods` (≤ 30), `cohortEvent`, `returnEvent` |

A lista de dimensões do `breakdown` é **fechada de propósito** (`event`, `path`,
`country`, `device`, `browser`, `os`, `referrer`): o nome da dimensão vira parte
da expressão SQL, então aceitar string livre seria abrir a porta para injeção. A
única forma dinâmica é `prop:<chave>` — e aí a chave viaja como parâmetro ligado,
nunca concatenada.

Retenção não aceita granularidade de mês: o cálculo do índice do período divide
por uma duração fixa, e mês não tem uma.

### Consultas que a API se recusa a responder

Uma API de analytics aceita perguntas arbitrárias, e algumas são caras demais:

- **Orçamento de pontos** (1000): pedir seis anos em granularidade de hora
  geraria mais de 50 mil pontos — rejeitado com `RANGE_TOO_LARGE` antes de
  qualquer ida ao banco.
- **`statement_timeout` de 30 s** no pool: o erro `57014` do Postgres é traduzido
  em `QUERY_TIMEOUT`, com a orientação de reduzir o intervalo.
- **Funil de no máximo 8 etapas**: cada etapa é mais uma CTE e mais um join.
- **Rate limit por tipo de tráfego**: 300 req/min no painel (origem humana),
  6.000 req/min por chave na ingestão (origem: SDK).

---

## Endpoints

```
POST   /v1/auth/register              POST /v1/auth/login       GET /v1/auth/me

GET    /v1/projects                   POST /v1/projects
GET    /v1/projects/:projectId        DELETE /v1/projects/:projectId
POST   /v1/projects/:projectId/keys   GET  /v1/projects/:projectId/keys
DELETE /v1/projects/:projectId/keys/:keyId

POST   /v1/events                     ← ingestão, autenticada por chave bk_

GET    /v1/projects/:projectId/reports/overview
GET    /v1/projects/:projectId/reports/timeseries
GET    /v1/projects/:projectId/reports/breakdown
GET    /v1/projects/:projectId/reports/funnel
GET    /v1/projects/:projectId/reports/retention
POST   /v1/projects/:projectId/rollup ← recalcula a pré-agregação

GET    /docs                          ← referência interativa (Scalar)
```

## Exemplos de uso

Enviar um lote de eventos:

```bash
curl -X POST http://localhost:3333/v1/events \
  -H "Authorization: Bearer bk_sua_chave_de_ingestao" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"name":"checkout_concluido","anonymousId":"a1b2c3","path":"/checkout/sucesso","country":"BR","device":"mobile","properties":{"plano":"pro","valor":89.9},"idempotencyKey":"pedido-10432"}]}'
```

```json
{ "received": 1, "accepted": 1, "duplicates": 0 }
```

Funil de três etapas, só para quem está no plano pro:

```bash
curl -G http://localhost:3333/v1/projects/$PROJECT_ID/reports/funnel \
  -H "Authorization: Bearer $JWT" \
  --data-urlencode "from=2026-07-01" \
  --data-urlencode "to=2026-08-01" \
  --data-urlencode "timezone=America/Sao_Paulo" \
  --data-urlencode "steps=produto_visto,carrinho_adicionado,checkout_concluido" \
  --data-urlencode "window=24h" \
  --data-urlencode 'properties={"plano":"pro"}'
```

---

## Como executar

Pré-requisitos: **Node 22+** e **Docker** (para o Postgres).

```bash
cp .env.example .env      # ajuste JWT_SECRET: openssl rand -hex 32
npm install
npm run docker:up         # Postgres 16 na porta 5433 do host
npm run db:migrate
npm run db:seed           # ~2.000.000 de eventos, 25 mil visitantes, 90 dias
npm run dev               # http://localhost:3333  ·  docs em /docs
```

O container sobe com `shared_buffers=256MB`, `work_mem=32MB` e
`max_parallel_workers_per_gather=4`: analytics faz varredura grande, e o padrão
de 4 MB de `work_mem` derrubaria as ordenações para disco.

A porta **5433** no host é proposital, para não conflitar com um Postgres já
instalado na 5432.

## Variáveis de ambiente

| Variável | Padrão | Observação |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` / `HOST` | `3333` / `0.0.0.0` | |
| `LOG_LEVEL` | `info` | níveis do pino |
| `DATABASE_URL` | — | obrigatória |
| `JWT_SECRET` | — | **mínimo 32 caracteres**, validado no start |
| `JWT_EXPIRES_IN` | `1h` | |
| `MAX_EVENTS_PER_BATCH` | `500` | teto de 5000 |
| `INGEST_RATE_LIMIT_PER_MINUTE` | `6000` | por chave |

## Estrutura de pastas

```
src/
  server.ts               sobe o processo
  app.ts                  monta a aplicação e registra plugins e rotas
  env.ts                  valida o .env com Zod
  db/                     schema.ts (Drizzle), migrate.ts, migrations/
  plugins/                auth.ts, error-handler.ts
  lib/                    credentials.ts, errors.ts
  modules/
    auth/                 register, login, me
    projects/             projetos e chaves de API
    ingest/               routes, schemas, service
    reports/              routes, schemas e reports.queries.ts (o SQL)
scripts/                  seed.ts, bench.ts, rollup.ts
tests/                    auth, ingest, reports + helpers e global-setup
docs/                     DATABASE.md, PERFORMANCE.md
```

## Testes

```bash
npm test          # vitest run
npm run typecheck
```

São **testes de integração contra um Postgres real** (banco `beacon_test` na
5433). Trocá-lo por um mock invalidaria justamente o que eles verificam:
`date_trunc`, funções de janela e fronteiras de fuso são executados pelo banco,
não pela aplicação.

Rodam em **fork único, sem paralelismo** (`vitest.config.ts`): os arquivos
compartilham o mesmo banco, e em paralelo um truncaria a tabela enquanto o outro
consulta — falha intermitente, o pior tipo de teste que existe.

O CI (`.github/workflows/ci.yml`) sobe um Postgres 16 como serviço e roda a mesma
suíte a cada push e pull request.

## Dependências e segurança

```bash
npm audit              # estado atual
npm run verifica:deps  # confere que as trocas de versão não mudaram o comportamento
```

Uma auditoria encontrou **três falhas críticas e duas altas**, todas resolvidas
por atualizações de versão maior:

| Pacote | De | Para | O que corrigiu |
|---|---|---|---|
| `@fastify/jwt` | 9.x | 10.2.2 | Seis falhas no `fast-jwt`, entre elas **bypass de autenticação** com segredo HMAC vazio, confusão de algoritmo com chave RSA prefixada por espaço e vazamento de claims entre tokens por colisão de cache |
| `drizzle-orm` | 0.38.x | 0.45.2 | **SQL injection** por escape incorreto de identificadores |
| `vitest` | 2.x | 4.1.11 | Leitura e execução de arquivo arbitrário quando o servidor de UI está escutando; path traversal no Vite |

### Como as trocas foram verificadas

Atualização de versão maior não é troca de número: `npm audit` diz que a falha
sumiu, não que o código continua funcionando. Como a suíte de integração exige
um Postgres no ar, `scripts/verifica-dependencias.ts` cobre o essencial sem
banco nenhum — ele registra o plugin de JWT de verdade e usa `.toSQL()` do
Drizzle para inspecionar o SQL gerado:

- token assinado é verificado e devolve o mesmo payload;
- token adulterado é rejeitado;
- token com `alg: none` é rejeitado;
- identificadores saem entre aspas duplas;
- valores saem como `$1`, nunca interpolados no texto da consulta;
- um payload de injeção (`'; DROP TABLE users; --`) vira parâmetro, e a string
  não aparece em lugar nenhum do SQL.

O último item é o que fecha o ciclo: era exatamente a geração de identificadores
que estava vulnerável, e é ela que o teste inspeciona.

### O que ficou em aberto, de propósito

Sobraram **quatro falhas moderadas**, todas a mesma cadeia:
`drizzle-kit` → `@esbuild-kit/esm-loader` → `esbuild`.

A correção que o `npm audit fix --force` propõe é **rebaixar** o `drizzle-kit`
de 0.31 para 0.18 — quinze versões para trás, quebrando a geração de migrations.

Não vale a pena, por três motivos:

1. `drizzle-kit` é dependência de desenvolvimento; não vai para produção;
2. a falha do `esbuild` só existe com o **servidor de desenvolvimento** dele no
   ar, e o `drizzle-kit` usa o `esbuild` apenas para empacotar o arquivo de
   configuração — nunca sobe servidor;
3. a cadeia vem de cima: não há versão do `drizzle-kit` que a resolva hoje.

Saber quando **não** aplicar a correção sugerida faz parte do trabalho. Um
`npm audit` limpo obtido às custas de quinze versões de regressão seria um
número melhor e um projeto pior.

## Performance

`npm run bench` roda cada consulta uma vez para aquecer o cache (a primeira
execução mede o disco, não a consulta), depois mede cinco vezes, registra a
**mediana** e imprime `EXPLAIN (ANALYZE, BUFFERS)`. A metodologia, as três
decisões que mais importam (ordem do índice composto, escopo da pré-agregação e
`ANALYZE` depois da carga) e o que ficou de fora estão em
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

> A tabela de resultados desse documento ainda está com `_a medir_`: o benchmark
> precisa rodar sobre a massa do seed para ser preenchido.

O rollup diário só é usado quando é **honesto** usá-lo. São duas perguntas
diferentes, e as duas precisam ser respondidas com sim.

A primeira é sobre o **formato** da pergunta: granularidade ≥ dia, fuso UTC,
métrica diferente de `sessions`, únicos apenas em granularidade de dia
(visitantes únicos não são somáveis) e sem filtro por dimensão que ele não tem.
Fora dessas condições ele mentiria por construção.

A segunda é sobre os **dados**: o rollup tem esse período processado? A tabela
`rollup_coverage` registra todo dia que a pré-agregação percorreu, inclusive os
dias que não tiveram evento nenhum — e é essa distinção que importa. Olhar só as
linhas de `daily_event_rollup` não serviria, porque a ausência de linha lá é
ambígua entre "nunca processado" e "processado e vazio", e as duas situações
pedem respostas opostas.

Sem essa segunda verificação, um rollup vazio ou atrasado devolvia **zeros**, sem
erro e sem aviso: o gráfico mostrava um período sem tráfego que na verdade estava
cheio de eventos. Na dúvida, a consulta cai para a tabela bruta — mais lento e
certo é melhor que rápido e errado.

### `from`, `to` e `timezone`

`from` e `to` nomeiam os períodos; `timezone` diz onde cai a fronteira do dia.
Pedir `from=2026-07-01`, `to=2026-08-01` com `timezone=America/Sao_Paulo`
devolve os dias de julho agrupados pela meia-noite de São Paulo — e não um
período de 30 de junho, que é o que sairia se os limites fossem convertidos de
fuso antes de virarem a régua do gráfico.

> **Limitação conhecida.** O filtro de período (`WHERE occurred_at >= from AND
> < to`) é aplicado sobre instantes, não sobre a fronteira local do dia. Num
> fuso diferente de UTC, isso deixa o último período do intervalo incompleto
> pela diferença do fuso — três horas, no caso de São Paulo. Os períodos do meio
> são exatos. Resolver isso significa converter `from` e `to` para o fuso pedido
> em todos os relatórios, e não só na série temporal; está na lista de
> melhorias.

## Decisões e trade-offs

| Decisão | O que ganhamos | O que abrimos mão |
|---|---|---|
| Colunas + JSONB, em vez de um dos extremos | Agrupamento rápido nas dimensões conhecidas e liberdade no resto | Duas formas de guardar atributo — é preciso decidir em qual metade cada campo entra |
| SQL à mão nos relatórios, com Drizzle só no schema | Controle sobre plano de execução e uso de índice | Consulta analítica não ganha a checagem de tipo do ORM |
| `INSERT` em vez de `COPY` na ingestão | Deduplicação com `ON CONFLICT` | `COPY` seria mais rápido em carga massiva — faz sentido para importação, não para tempo real |
| SHA-256 nas chaves de API | A autenticação de ingestão não vira gargalo | Só serve para segredo de alta entropia; não para senha escolhida por humano |
| Pré-agregação com escopo restrito | Resposta rápida no caso comum sem mentir nos números | Mais código: duas fontes possíveis para a mesma pergunta |
| Testes contra Postgres real | Testa o que de fato executa a lógica | Suíte mais lenta e dependente de banco no CI |
| Valor de propriedade só escalar | Índice GIN pequeno; toda propriedade é agrupável | Nada de objeto aninhado em `properties` |

## Melhorias futuras

- [ ] Preencher a tabela de resultados de [docs/PERFORMANCE.md](docs/PERFORMANCE.md) rodando `npm run bench`
- [ ] Particionamento de `events` por mês, quando a tabela justificar
- [ ] Rollup incremental agendado, em vez de recálculo sob demanda
- [ ] SDK JavaScript de ingestão, com fila e reenvio usando `idempotencyKey`
- [ ] Painel web consumindo os relatórios
- [ ] Exportação em CSV dos relatórios
- [ ] Aplicar `from`/`to` na fronteira local do dia em todos os relatórios, não só na régua da série temporal

## Licença

MIT.
