import 'dotenv/config';
import { z } from 'zod';

/**
 * O processo não sobe com configuração inválida.
 *
 * Validar variáveis de ambiente na borda é o mesmo princípio de validar o corpo
 * de uma requisição: a partir daqui o resto do código trabalha com um objeto
 * tipado e confiável, em vez de espalhar `process.env.X!` e `?? valorPadrao`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa ter no mínimo 32 caracteres'),
  JWT_EXPIRES_IN: z.string().default('1h'),

  MAX_EVENTS_PER_BATCH: z.coerce.number().int().positive().max(5000).default(500),
  INGEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(6000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`Configuração inválida em .env:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
