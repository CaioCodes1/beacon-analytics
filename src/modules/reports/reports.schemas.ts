import { z } from 'zod';

/** Fusos válidos segundo o runtime — evita repassar lixo ao `AT TIME ZONE`. */
const timezoneSchema = z
  .string()
  .default('UTC')
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Fuso horário desconhecido (use um nome IANA, ex.: America/Sao_Paulo)' },
  );

/**
 * Filtros comuns a todos os relatórios.
 *
 * `properties` chega como JSON na query string e é aplicado com o operador de
 * contenção `@>`, que é o único coberto pelo índice GIN jsonb_path_ops.
 */
export const reportFiltersBase = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  timezone: timezoneSchema,

  event: z.string().min(1).max(120).optional(),
  path: z.string().max(2048).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  device: z.enum(['desktop', 'mobile', 'tablet', 'bot', 'unknown']).optional(),
  browser: z.string().max(80).optional(),
  os: z.string().max(80).optional(),

  properties: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('não é objeto');
        }
        return parsed as Record<string, unknown>;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'properties precisa ser um objeto JSON, ex.: {"plano":"pro"}',
        });
        return z.NEVER;
      }
    }),
});

/**
 * `from < to` vale para todo relatório, então a checagem mora num só lugar.
 *
 * A assinatura é genérica sobre o tipo de saída, e não sobre `ZodTypeAny`, para
 * que o schema devolvido continue carregando os campos: com `ZodTypeAny` o
 * `refine` apaga a inferência e todo `request.query` chegaria como `any` nas
 * rotas — exatamente o que o TypeScript deveria estar evitando aqui.
 */
function withOrderedDates<Output extends { from: Date; to: Date }, Def extends z.ZodTypeDef, Input>(
  schema: z.ZodType<Output, Def, Input>,
) {
  return schema.refine((value) => value.from < value.to, {
    message: '`from` precisa ser anterior a `to`',
    path: ['from'],
  });
}

export const reportFiltersSchema = withOrderedDates(reportFiltersBase);
export type ReportFilters = z.infer<typeof reportFiltersBase>;

export const intervalSchema = z.enum(['hour', 'day', 'week', 'month']);
export type Interval = z.infer<typeof intervalSchema>;

export const metricSchema = z.enum(['events', 'visitors', 'sessions']);
export type Metric = z.infer<typeof metricSchema>;

/**
 * Dimensões que o breakdown aceita.
 *
 * A lista é fechada de propósito: o nome da dimensão vira parte da expressão
 * SQL, então aceitar qualquer string seria abrir a porta para injeção. A única
 * forma dinâmica é `prop:<chave>`, e aí a chave viaja como parâmetro ligado,
 * nunca concatenada.
 */
export const FIXED_DIMENSIONS = [
  'event',
  'path',
  'country',
  'device',
  'browser',
  'os',
  'referrer',
] as const;

export const dimensionSchema = z
  .string()
  .refine(
    (value) =>
      (FIXED_DIMENSIONS as readonly string[]).includes(value) ||
      /^prop:[A-Za-z0-9_.-]{1,60}$/.test(value),
    {
      message:
        'Dimensão inválida. Use event, path, country, device, browser, os, referrer ou prop:<chave>',
    },
  );

export const timeseriesQuerySchema = withOrderedDates(
  reportFiltersBase.extend({
    interval: intervalSchema.default('day'),
    metric: metricSchema.default('events'),
  }),
);

export const breakdownQuerySchema = withOrderedDates(
  reportFiltersBase.extend({
    dimension: dimensionSchema,
    limit: z.coerce.number().int().min(1).max(100).default(10),
  }),
);

export const funnelQuerySchema = withOrderedDates(
  reportFiltersBase.extend({
    steps: z
      .string()
      .transform((value) => value.split(',').map((step) => step.trim()).filter(Boolean))
      .pipe(
        z
          .array(z.string().min(1).max(120))
          .min(2, 'Um funil precisa de pelo menos 2 etapas')
          .max(8, 'Máximo de 8 etapas'),
      ),
    window: z
      .string()
      .regex(/^\d{1,4}[hd]$/, 'Use um formato como 24h ou 7d')
      .default('24h'),
  }),
);

export const retentionQuerySchema = withOrderedDates(
  reportFiltersBase.extend({
    // Mês fica de fora: o cálculo do índice do período divide por uma duração
    // fixa, e mês não tem uma.
    granularity: z.enum(['day', 'week']).default('day'),
    periods: z.coerce.number().int().min(1).max(30).default(7),
    cohortEvent: z.string().min(1).max(120).optional(),
    returnEvent: z.string().min(1).max(120).optional(),
  }),
);

export type TimeseriesQuery = z.infer<typeof timeseriesQuerySchema>;
export type BreakdownQuery = z.infer<typeof breakdownQuerySchema>;
export type FunnelQuery = z.infer<typeof funnelQuerySchema>;
export type RetentionQuery = z.infer<typeof retentionQuerySchema>;
