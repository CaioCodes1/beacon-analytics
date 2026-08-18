import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://beacon:beacon@localhost:5433/beacon_test';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],

    /**
     * Os testes são de integração: falam com um Postgres de verdade, no mesmo
     * banco. Rodar arquivos em paralelo faria um truncar a tabela enquanto o
     * outro consulta, e a suíte falharia de forma intermitente — o pior tipo de
     * teste que existe.
     */
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,

    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'chave-de-teste-com-pelo-menos-32-caracteres-ok',
      LOG_LEVEL: 'error',
    },

    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
