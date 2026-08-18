# Performance

Como as consultas de relatório se comportam sobre uma base grande, o que foi
otimizado e o que foi deliberadamente deixado como está.

---

## Metodologia

Nada aqui vale sobre uma base de brinquedo. Com cinco mil eventos, toda consulta
responde em milissegundos, todo plano parece bom e nenhuma otimização se
justifica. Os números abaixo foram medidos sobre a massa gerada pelo seed:

```bash
docker compose up -d
npm run db:migrate
npm run db:seed      # ~2.000.000 de eventos em 90 dias, 25 mil visitantes
npm run bench
```

O `bench` roda cada consulta uma vez para aquecer o cache (a primeira execução
mede o disco, não a consulta), depois mede cinco vezes e registra a **mediana**.
Em seguida imprime `EXPLAIN (ANALYZE, BUFFERS)` de cada uma.

Ambiente da medição: Postgres 16 em container, `shared_buffers=256MB`,
`work_mem=32MB` (ver [`docker-compose.yml`](../docker-compose.yml)). O default de
`work_mem` é 4MB, o que joga qualquer agregação grande para arquivo temporário em
disco — para carga analítica é a primeira coisa a ajustar.

> **Estado atual:** o ambiente Docker da máquina de desenvolvimento ainda não
> subiu, então a tabela de resultados abaixo está vazia de propósito. Preencher
> com a saída real de `npm run bench` — não estimar.

---

## Resultados

| Consulta | Mediana | Fonte |
|---|---|---|
| Série diária, 30 dias — tabela bruta | _a medir_ | `events` |
| Série diária, 30 dias — rollup | _a medir_ | `daily_event_rollup` |
| Visitantes únicos, 30 dias | _a medir_ | `events` |
| Breakdown por país, 30 dias | _a medir_ | `events` |
| Filtro por propriedade JSONB | _a medir_ | GIN |
| Funil de 3 etapas, 30 dias | _a medir_ | `events` |
| Retenção diária, 14 coortes | _a medir_ | `events` |

---

## As três decisões que mais importam

### 1. O índice composto, na ordem certa

```sql
CREATE INDEX events_project_time_idx ON events (project_id, occurred_at);
```

Igualdade antes de intervalo. Com `project_id` primeiro, o planner desce até o
bloco do projeto e ali o tempo já está ordenado — lê só as páginas do período.
Invertido, o índice localizaria o intervalo de tempo de todos os projetos e
sobraria um filtro linha a linha.

O sinal disso no `EXPLAIN` é a diferença entre `Index Scan` com as duas condições
em `Index Cond:` e um `Index Scan` que joga metade delas para `Filter:`. Condição
em `Filter` significa linha lida e descartada — trabalho pago sem retorno.

### 2. A pré-agregação, com escopo honesto

O rollup diário responde séries em granularidade de dia ou maior sem tocar a
tabela de fatos. Mas ele só é usado quando a pergunta cabe na forma em que foi
gravado — a lógica está em `canUseRollup()`:

| Condição | Por quê |
|---|---|
| granularidade ≥ dia | o rollup é diário; hora não existe nele |
| fuso = UTC | as datas do rollup são UTC; outro fuso desloca as fronteiras dos dias |
| métrica ≠ `sessions` | sessões não foram pré-agregadas |
| únicos só em granularidade de dia | **visitantes únicos não são somáveis** |
| sem filtro por path/browser/os/propriedade | não são dimensões do rollup |

Não cabendo, a consulta vai para a tabela bruta. **A resposta é sempre correta —
o que muda é o tempo.** O campo `source` na resposta da API (`"rollup"` ou
`"raw"`) diz qual caminho foi usado, o que torna a latência observada explicável
em vez de misteriosa.

O ponto sutil é o dos únicos. Somar `unique_visitors` de segunda e terça para
obter o número da semana conta duas vezes quem apareceu nos dois dias. Essa
informação foi descartada na pré-agregação e não tem como voltar. Preferir um
número rápido e errado a um número lento e certo seria o pior tipo de otimização.

### 3. ANALYZE depois de carregar

Logo após uma carga grande, as estatísticas do planner ainda dizem que a tabela
está praticamente vazia — e com essa informação ele escolhe varredura sequencial
em vez do índice. É a explicação mais frequente para "criei o índice e o Postgres
não usa".

Por isso o seed roda `ANALYZE events` no fim, e o script de rollup roda
`ANALYZE daily_event_rollup`. Sem esse passo, qualquer medição feita em seguida
estaria medindo o planner mal informado, não o banco.

---

## Proteções contra consulta abusiva

Uma API de analytics aceita perguntas arbitrárias, e algumas são caras demais
para serem respondidas.

- **Orçamento de pontos** (`MAX_BUCKETS = 1000`): pedir seis anos em
  granularidade de hora geraria mais de 50 mil pontos. Rejeitado com
  `RANGE_TOO_LARGE` antes de qualquer ida ao banco.
- **`statement_timeout = 30s`** no pool: nenhuma consulta prende uma conexão
  indefinidamente. O erro `57014` do Postgres é traduzido em `QUERY_TIMEOUT` com
  a orientação de reduzir o intervalo.
- **Limite de etapas do funil** (8): cada etapa é mais uma CTE e mais um join na
  cadeia; o custo cresce rápido.
- **Rate limit** separado por tipo de tráfego: 300 req/min para o painel (origem
  humana) e 6.000 req/min por chave para ingestão (origem: SDK).

---

## Ingestão

Um lote vira **um único `INSERT` com N linhas**, não N inserts. Cada ida ao banco
custa mais que a gravação em si — em 500 comandos separados, o tempo é dominado
por espera de rede.

A deduplicação usa `ON CONFLICT DO NOTHING` sobre o índice único parcial de
`idempotency_key`, e não uma consulta prévia de "o que já existe". A versão com
consulta prévia tem uma janela de corrida entre ler e escrever: dois lotes
simultâneos com a mesma chave passariam os dois pela verificação e gravariam
duplicado. Deixar o índice decidir elimina a janela.

---

## O que ficou de fora, e por quê

- **`COPY` em vez de `INSERT` na ingestão.** `COPY` é claramente mais rápido para
  cargas grandes, mas não suporta `ON CONFLICT` — perderíamos a deduplicação. Faz
  sentido para importação em massa, não para o endpoint de tempo real.
- **Particionamento por mês.** Ganho real só a partir de dezenas de milhões de
  linhas, e complica retenção de dados e migrations. Descrito em
  [DATABASE.md](DATABASE.md#o-que-ficou-de-fora).
- **Cache de respostas (Redis).** A camada certa depois que as consultas já estão
  boas. Adicionar cache antes disso esconde a consulta ruim em vez de resolvê-la.
- **HyperLogLog para únicos combináveis.** Resolveria a limitação do rollup, ao
  custo de ~2% de erro e de uma extensão fora do Postgres padrão.
