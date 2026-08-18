# Banco de dados

Documento sobre **por que** o schema é assim. A definição executável está em
[`src/db/schema.ts`](../src/db/schema.ts) e nas migrations em
[`src/db/migrations/`](../src/db/migrations/).

---

## Modelo

```
users ──< projects ──< api_keys
                  │
                  ├──< events                (tabela de fatos, cresce sem limite)
                  └──< daily_event_rollup    (pré-agregação derivada de events)
```

`users`, `projects` e `api_keys` são tabelas de cadastro: milhares de linhas, no
máximo. `events` é de outra natureza — é ela que define todas as decisões
técnicas do projeto.

---

## A tabela de eventos

### Modelo híbrido: colunas + JSONB

```sql
name, occurred_at, anonymous_id, user_id, session_id,
path, referrer, country, device, browser, os,   -- dimensões conhecidas
properties jsonb                                -- o resto
```

Havia duas saídas óbvias, e as duas são ruins:

| Abordagem | Problema |
|---|---|
| Tudo em colunas | Cada campo novo que um cliente quer enviar vira uma migration. Inviável para uma API que recebe dados de terceiros. |
| Tudo em JSONB | Agrupar por país passa a exigir extrair e converter texto a cada linha. Sem tipo, sem CHECK, índices maiores e mais lentos. |

O meio-termo é o que ferramentas reais de analytics fazem: as dimensões que
**todo** evento tem viram colunas de verdade — tipadas, indexáveis, baratas de
agrupar — e o que varia por cliente vai para `properties`.

`properties` é indexado com **GIN `jsonb_path_ops`**, que é menor e mais rápido
que o GIN padrão, ao custo de suportar só o operador de contenção `@>`. Como
`@>` é o único que a API expõe (`?properties={"plano":"pro"}`), o custo é zero.

### Por que `occurred_at` e `received_at` são separados

`occurred_at` é o horário no cliente; `received_at` é quando o servidor gravou.
Um celular que ficou sem rede envia o lote acumulado ao reconectar: os dois
horários podem estar horas distantes. Todo relatório usa `occurred_at` — é o que
responde "quando isso aconteceu". `received_at` fica para medir atraso de
ingestão e depurar.

É por causa desse par que o rollup reprocessa os últimos 3 dias em vez de só
ontem: o evento atrasado precisa entrar no dia em que aconteceu.

### `anonymous_id` e `user_id`

`anonymous_id` identifica o dispositivo e existe sempre. `user_id` só aparece
depois do login. Todas as métricas de "visitantes únicos" usam `anonymous_id`,
porque é a única identidade presente em 100% dos eventos.

`user_id` tem índice **parcial** (`WHERE user_id IS NOT NULL`): a maioria dos
eventos é anônima, e indexar a coluna inteira seria pagar espaço e manutenção
por milhões de NULLs que nenhuma consulta procura.

---

## Índices

| Índice | Colunas | Para quê |
|---|---|---|
| `events_project_time_idx` | `(project_id, occurred_at)` | O índice de trabalho. Todo relatório passa por ele. |
| `events_project_name_time_idx` | `(project_id, name, occurred_at)` | Funis e filtros por evento. |
| `events_project_anon_time_idx` | `(project_id, anonymous_id, occurred_at)` | Únicos e retenção. |
| `events_project_user_idx` | `(project_id, user_id)` parcial | Consultas por usuário identificado. |
| `events_idempotency_unique` | `(project_id, idempotency_key)` parcial e único | Deduplicação da ingestão. |
| `events_properties_gin` | `properties` (GIN jsonb_path_ops) | Filtro por propriedade customizada. |

### A ordem das colunas não é decorativa

`(project_id, occurred_at)` e não `(occurred_at, project_id)`.

Um índice B-tree composto é percorrido da esquerda para a direita. A regra é
**igualdade antes de intervalo**: com `project_id` na frente, o Postgres desce
direto até o bloco daquele projeto e ali o intervalo de tempo já está ordenado —
lê exatamente as páginas do período. Invertido, ele encontraria o intervalo de
tempo de *todos* os projetos e teria que filtrar linha a linha o que interessa.

Todas as consultas em [`reports.queries.ts`](../src/modules/reports/reports.queries.ts)
montam o `WHERE` nessa ordem por esse motivo.

### BRIN foi considerado e descartado

`occurred_at` é quase correlacionado com a ordem física da tabela, que é o caso
clássico de um índice BRIN — minúsculo e muito eficiente para intervalos. Mas
nenhuma consulta desta API filtra por tempo *sem* filtrar por projeto, e para
essa combinação o B-tree composto já resolve em uma descida. BRIN só compensaria
numa instalação de inquilino único, ou se `events` fosse particionada e cada
partição precisasse de um índice de intervalo próprio.

---

## Restrições no banco

A API valida tudo com Zod antes de gravar. Ainda assim, as regras estão também
em CHECK constraints ([`0001_analytics_ddl.sql`](../src/db/migrations/0001_analytics_ddl.sql)).

Não é redundância desnecessária: a validação da aplicação protege contra
clientes, as constraints protegem contra *nós mesmos* — um script de importação,
um `psql` aberto às duas da manhã, um bug futuro numa refatoração. Dado corrompido
em tabela de fatos não dá erro; dá relatório errado, que ninguém percebe.

As mais importantes:

- `events_properties_is_object` — sem ela, um `properties` que fosse `[1,2,3]`
  faria `properties ->> 'plano'` devolver NULL silenciosamente, e o breakdown por
  plano ficaria errado sem nenhum sinal de erro.
- `events_occurred_at_not_future` — impede que relógio desregulado de cliente
  contamine a série temporal com dados no futuro.
- `rollup_uniques_within_events` — visitantes únicos nunca podem exceder o total
  de eventos da linha; é uma checagem barata que pega erro de lógica no rollup.

---

## Pré-agregação: `daily_event_rollup`

```sql
PRIMARY KEY (project_id, day, event_name, country, device)
event_count      bigint   -- somável
unique_visitors  bigint   -- NÃO somável
```

Reduz a cardinalidade de "uma linha por evento" para "uma linha por dia × evento
× país × dispositivo". Uma série de 30 dias deixa de varrer centenas de milhares
de linhas e passa a ler algumas centenas.

### O detalhe que mais importa: únicos não somam

`event_count` pode ser somado à vontade. `unique_visitors` **não**.

Se segunda teve 100 visitantes únicos e terça teve 100, a semana não teve 200 —
teve algum número entre 100 e 200, dependendo de quantos são a mesma pessoa. A
soma conta duas vezes quem voltou, e ela é a única informação que a pré-agregação
já jogou fora.

Por isso o rollup só responde únicos na granularidade exata em que foi gravado
(dia). Semana e mês voltam para a tabela bruta, onde o `count(DISTINCT ...)` ainda
é possível. A regra está em `canUseRollup()` e o campo `source` da resposta diz
qual caminho foi usado.

A solução de mercado para esse problema é [HyperLogLog](https://github.com/citusdata/postgresql-hll):
um esboço probabilístico que *é* combinável, com ~2% de erro. Fica como melhoria
futura — exige uma extensão que não vem no Postgres padrão, e trocar precisão por
velocidade tem que ser uma decisão consciente, não um efeito colateral.

### Recálculo

`refresh_daily_rollup(project_id, from, to)` apaga a janela e reinsere. Apagar
antes é necessário: se um dia deixou de ter eventos de certo tipo, `ON CONFLICT`
sozinho atualizaria as linhas que sobraram e deixaria a antiga para trás.

Ser idempotente é o que permite rodá-la de novo sem medo — no agendador, na mão,
ou depois de corrigir um bug de ingestão.

---

## O que ficou de fora

- **Particionamento de `events` por mês.** É o próximo passo natural quando a
  tabela passar de algumas dezenas de milhões de linhas: descartar dados antigos
  vira `DROP TABLE` de uma partição em vez de um `DELETE` que gera bloat. Não foi
  feito porque, no volume atual, adicionaria complexidade sem ganho mensurável.
- **Um banco separado para leitura.** Ingestão e relatório competem pelos mesmos
  recursos. Em produção real, réplica de leitura.
- **Geolocalização por IP.** Hoje `country` vem do cliente. Resolver no servidor
  exige uma base GeoIP e um cache.
