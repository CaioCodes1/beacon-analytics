import { z } from 'zod';

/**
 * Um valor de propriedade customizada é escalar de propósito.
 *
 * Aceitar objetos aninhados aqui parece generoso, mas significa aceitar
 * documentos de profundidade arbitrária na tabela que mais cresce — e nenhum
 * relatório sabe agrupar por um objeto. Escalar cobre o caso real (`plano`,
 * `valor`, `experimento`) e mantém o índice GIN pequeno.
 */
const propertyValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const eventInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'O nome do evento é obrigatório')
    .max(120, 'O nome do evento é longo demais'),

  /**
   * Quando o evento aconteceu no cliente. Ausente significa "agora": um SDK que
   * envia em tempo real não precisa carregar relógio próprio.
   */
  occurredAt: z.coerce.date().optional(),

  anonymousId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128).optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),

  path: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),

  country: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),

  device: z.enum(['desktop', 'mobile', 'tablet', 'bot', 'unknown']).optional(),
  browser: z.string().max(80).optional(),
  os: z.string().max(80).optional(),

  properties: z.record(propertyValue).default({}),

  /**
   * Chave de deduplicação. Um SDK que reenvia por falha de rede manda a mesma
   * chave; o banco descarta a segunda gravação sem erro.
   */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export type EventInput = z.infer<typeof eventInputSchema>;

export const ingestBodySchema = z.union([
  eventInputSchema,
  z.object({ events: z.array(eventInputSchema).min(1) }),
]);

export const ingestResponseSchema = z.object({
  received: z.number().int().describe('Quantos eventos vieram no corpo'),
  accepted: z.number().int().describe('Quantos foram gravados'),
  duplicates: z.number().int().describe('Descartados por idempotencyKey repetida'),
});
