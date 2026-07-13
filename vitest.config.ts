import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/db/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dashboard/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialize files so DB suites share one migrate without deadlocks
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3099',
      LOG_LEVEL: 'fatal',
      ADMIN_API_KEY: 'test-admin-api-key-min-16',
      DATABASE_URL: 'postgresql://zapo:zapo@127.0.0.1:5555/zapo_test',
      TEST_DATABASE_URL: 'postgresql://zapo:zapo@127.0.0.1:5555/zapo_test',
      AUTO_CONNECT_ON_BOOT: 'false',
      RECONNECT_MAX_ATTEMPTS: '3',
      WEBHOOK_TIMEOUT_MS: '1000',
      VOIP_MAX_CONCURRENT_CALLS: '5',
      VOIP_END_CALL_ON_WS_CLOSE: 'false',
      MEDIA_TMP_DIR: '/tmp/zapo-rest-test-media',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
      // Raised as store/manager/voip suites land — push toward 85% overall next.
      thresholds: {
        // Sprint C: routes + phone-resolve inject suite — floor 58; live ~60%.
        lines: 58,
        functions: 60,
        branches: 60,
        statements: 58,
      },
    },
  },
})
