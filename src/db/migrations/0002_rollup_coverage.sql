/* -------------------------------------------------------------------------- */
/* Cobertura da pré-agregação                                                 */
/* -------------------------------------------------------------------------- */

-- O problema que esta tabela resolve.
--
-- O relatório decidia usar o rollup olhando só o FORMATO da pergunta:
-- granularidade, fuso, métrica, filtros. Nunca perguntava se o rollup tinha
-- dados do período pedido. Um rollup vazio, ou atrasado em relação à pergunta,
-- devolvia zeros — sem erro, sem aviso. É o pior defeito possível num sistema
-- de análise: número errado com cara de número certo.
--
-- A verificação óbvia seria olhar os dias presentes em `daily_event_rollup`,
-- mas a ausência de uma linha ali é AMBÍGUA: pode significar "este dia nunca
-- foi processado" ou "este dia foi processado e não teve evento nenhum". As
-- duas coisas precisam de respostas opostas — a primeira exige cair para a
-- tabela bruta, a segunda pode responder zero com confiança.
--
-- Esta tabela desfaz a ambiguidade registrando TODO dia processado, inclusive
-- os que não tiveram evento algum.
CREATE TABLE IF NOT EXISTS rollup_coverage (
  project_id    uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day           date        NOT NULL,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, day)
);

-- Backfill conservador para bancos que já existiam: marca como cobertos apenas
-- os dias que têm linha no rollup. Um dia processado sem eventos não aparece
-- aqui e vai ser tratado como não coberto — o relatório cai para a tabela
-- bruta e responde certo, só que mais devagar. Errar para o lado da correção.
INSERT INTO rollup_coverage (project_id, day, refreshed_at)
SELECT project_id, day, max(refreshed_at)
FROM daily_event_rollup
GROUP BY project_id, day
ON CONFLICT (project_id, day) DO NOTHING;

-- A função passa a registrar a cobertura junto com os números.
--
-- A janela inteira é marcada a partir de `generate_series`, e não a partir das
-- linhas inseridas: é justamente o dia sem eventos que precisa ficar
-- registrado para não ser confundido com um dia que ninguém processou.
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

  INSERT INTO rollup_coverage (project_id, day, refreshed_at)
  SELECT p_project_id, d::date, now()
  FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') AS d
  ON CONFLICT (project_id, day) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;

  RETURN affected;
END;
$$;
