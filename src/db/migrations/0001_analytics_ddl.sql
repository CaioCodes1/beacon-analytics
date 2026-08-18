-- Regras que o ORM não expressa, escritas à mão.
--
-- A ideia geral: o banco é a última linha de defesa. A API valida com Zod, mas
-- se um script de importação, um psql aberto ou um bug futuro tentar gravar
-- lixo, é aqui que a gravação falha.

/* -------------------------------------------------------------------------- */
/* Integridade dos eventos                                                    */
/* -------------------------------------------------------------------------- */

ALTER TABLE events
  ADD CONSTRAINT events_name_not_blank
  CHECK (length(btrim(name)) BETWEEN 1 AND 120);

ALTER TABLE events
  ADD CONSTRAINT events_anonymous_id_not_blank
  CHECK (length(btrim(anonymous_id)) BETWEEN 1 AND 128);

-- ISO 3166-1 alfa-2 em maiúsculas, ou '??' quando não foi possível resolver.
ALTER TABLE events
  ADD CONSTRAINT events_country_iso
  CHECK (country IS NULL OR country ~ '^([A-Z]{2}|\?\?)$');

ALTER TABLE events
  ADD CONSTRAINT events_device_enum
  CHECK (device IS NULL OR device IN ('desktop', 'mobile', 'tablet', 'bot', 'unknown'));

-- `properties` precisa ser um objeto JSON, não um array nem um escalar solto.
-- Sem isso, `properties -> 'plano'` em cima de `[1,2,3]` só devolve NULL em
-- silêncio e o relatório fica errado sem ninguém perceber.
ALTER TABLE events
  ADD CONSTRAINT events_properties_is_object
  CHECK (jsonb_typeof(properties) = 'object');

-- Um evento pode chegar atrasado (cliente offline, retry), mas não pode ter
-- acontecido no futuro. Uma folga de 1 hora absorve relógios desregulados.
ALTER TABLE events
  ADD CONSTRAINT events_occurred_at_not_future
  CHECK (occurred_at <= received_at + interval '1 hour');

ALTER TABLE daily_event_rollup
  ADD CONSTRAINT rollup_counts_non_negative
  CHECK (event_count >= 0 AND unique_visitors >= 0);

-- Únicos nunca podem passar do total de eventos daquela linha. É uma checagem
-- barata que pega erro de lógica no cálculo do rollup.
ALTER TABLE daily_event_rollup
  ADD CONSTRAINT rollup_uniques_within_events
  CHECK (unique_visitors <= event_count);

/* -------------------------------------------------------------------------- */
/* Índice para filtros em propriedades customizadas                           */
/* -------------------------------------------------------------------------- */

-- GIN com jsonb_path_ops: índice menor e mais rápido que o padrão para o
-- operador de contenção `@>`, que é o único que a API expõe para filtrar
-- propriedades (ex.: properties @> '{"plano":"pro"}').
-- O preço é não suportar `?` (existência de chave) — que a API não usa.
CREATE INDEX events_properties_gin
  ON events USING gin (properties jsonb_path_ops);

/* -------------------------------------------------------------------------- */
/* Recálculo do rollup diário                                                 */
/* -------------------------------------------------------------------------- */

-- Recalcula a pré-agregação de um projeto em uma janela de dias.
--
-- É idempotente de propósito: pode rodar quantas vezes quiser, no cron ou na
-- mão, sem duplicar nada. Eventos que chegam atrasados são absorvidos ao
-- reprocessar os últimos dias.
--
-- `count(DISTINCT anonymous_id)` é gravado por dia porque é exatamente essa a
-- granularidade em que o número é válido. Somar essa coluna entre dias dá um
-- resultado errado — ver docs/PERFORMANCE.md.
CREATE OR REPLACE FUNCTION refresh_daily_rollup(
  p_project_id uuid,
  p_from date,
  p_to date
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  affected bigint;
BEGIN
  IF p_from > p_to THEN
    RAISE EXCEPTION 'janela inválida: % > %', p_from, p_to;
  END IF;

  -- Remove o intervalo antes de reinserir: se um dia deixou de ter eventos de
  -- um certo tipo, a linha antiga precisa sumir, e ON CONFLICT sozinho não
  -- apaga nada.
  DELETE FROM daily_event_rollup
  WHERE project_id = p_project_id
    AND day >= p_from
    AND day <= p_to;

  INSERT INTO daily_event_rollup (
    project_id, day, event_name, country, device,
    event_count, unique_visitors, refreshed_at
  )
  SELECT
    e.project_id,
    (e.occurred_at AT TIME ZONE 'UTC')::date AS day,
    e.name,
    COALESCE(e.country, '??'),
    COALESCE(e.device, 'unknown'),
    count(*),
    count(DISTINCT e.anonymous_id),
    now()
  FROM events e
  WHERE e.project_id = p_project_id
    AND e.occurred_at >= p_from::timestamptz
    AND e.occurred_at < (p_to + 1)::timestamptz
  GROUP BY 1, 2, 3, 4, 5;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
