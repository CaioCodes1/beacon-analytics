import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  bigserial,
  bigint,
  date,
  char,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* -------------------------------------------------------------------------- */
/* Contas e projetos                                                          */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('projects_slug_unique').on(table.slug),
    index('projects_owner_idx').on(table.ownerId),
  ],
);

/**
 * Chaves de ingestão.
 *
 * A chave em texto puro só existe uma vez: na resposta da criação. O banco
 * guarda apenas o hash — mesmo com dump do banco em mãos, ninguém consegue
 * enviar eventos em nome do projeto. O `prefix` (8 caracteres visíveis) serve
 * para o usuário reconhecer a chave na listagem e para reduzir o espaço de
 * busca na autenticação de uma varredura completa para uma linha.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_keys_prefix_unique').on(table.prefix),
    index('api_keys_project_idx').on(table.projectId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Eventos                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tabela de fatos. É a única que cresce sem limite, então todas as decisões
 * aqui são sobre leitura em volume.
 *
 * Modelo híbrido, que é o que ferramentas reais de analytics fazem:
 *
 *  - dimensões conhecidas (país, dispositivo, navegador, caminho) viram
 *    colunas de verdade — indexáveis, com tipo, baratas de agrupar;
 *  - o que é específico de cada cliente vai em `properties` (JSONB), sem exigir
 *    migration a cada campo novo que alguém queira enviar.
 *
 * Guardar tudo em JSONB seria mais flexível e muito mais lento; guardar tudo em
 * colunas seria mais rápido e inutilizável para o cliente.
 */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /** Quando aconteceu no cliente. É este o campo usado em todo relatório. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Quando chegou no servidor. Serve para medir atraso e depurar ingestão. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),

    /** Identidade do dispositivo/navegador. Sempre presente. */
    anonymousId: text('anonymous_id').notNull(),
    /** Identidade do usuário logado, quando existe. */
    userId: text('user_id'),
    sessionId: text('session_id'),

    path: text('path'),
    referrer: text('referrer'),
    country: char('country', { length: 2 }),
    device: text('device'),
    browser: text('browser'),
    os: text('os'),

    properties: jsonb('properties').notNull().default(sql`'{}'::jsonb`),

    /** Deduplicação de reenvios do cliente. Único por projeto. */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    /**
     * Índice de trabalho. Toda consulta de relatório filtra por projeto e por
     * intervalo de tempo, nesta ordem — a coluna de igualdade vem primeiro, a
     * de intervalo depois, senão o Postgres não consegue usar o segundo termo
     * para limitar a varredura.
     */
    index('events_project_time_idx').on(table.projectId, table.occurredAt),

    /** Funis e breakdown por evento filtram também pelo nome. */
    index('events_project_name_time_idx').on(table.projectId, table.name, table.occurredAt),

    /** Retenção e contagem de únicos agrupam por visitante. */
    index('events_project_anon_time_idx').on(table.projectId, table.anonymousId, table.occurredAt),

    /**
     * Parcial: a maioria dos eventos é anônima, então indexar `user_id` inteiro
     * seria pagar por milhões de NULLs que nunca são consultados.
     */
    index('events_project_user_idx')
      .on(table.projectId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),

    uniqueIndex('events_idempotency_unique')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Pré-agregação                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rollup diário.
 *
 * Séries temporais em granularidade de dia ou maior não precisam tocar a tabela
 * de fatos: a resposta já está calculada aqui. O ganho é de ordem de grandeza,
 * porque a cardinalidade cai de "um registro por evento" para "um registro por
 * dia × evento × país × dispositivo".
 *
 * Atenção ao que é somável: `eventCount` pode ser somado livremente entre
 * linhas; `uniqueVisitors` NÃO — dois dias com 100 visitantes únicos cada não
 * dão 200 únicos na semana. Por isso o rollup só responde únicos na
 * granularidade exata em que foi gravado (dia), e semana/mês voltam para a
 * tabela bruta. Ver docs/PERFORMANCE.md.
 */
export const dailyEventRollup = pgTable(
  'daily_event_rollup',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    eventName: text('event_name').notNull(),
    country: char('country', { length: 2 }).notNull().default('??'),
    device: text('device').notNull().default('unknown'),

    eventCount: bigint('event_count', { mode: 'number' }).notNull(),
    uniqueVisitors: bigint('unique_visitors', { mode: 'number' }).notNull(),

    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.day, table.eventName, table.country, table.device],
    }),
    index('rollup_project_day_idx').on(table.projectId, table.day),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
