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
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '3098',
      LOG_LEVEL: 'error',
      ADMIN_API_KEY: 'test-admin-api-key-min-16',
      DATABASE_URL: 'postgresql://zapo:zapo@127.0.0.1:5432/zapo_test',
      AUTO_CONNECT_ON_BOOT: 'false',
      RECONNECT_MAX_ATTEMPTS: '2',
      WEBHOOK_TIMEOUT_MS: '1000',
      VOIP_MAX_CONCURRENT_CALLS: '3',
      VOIP_END_CALL_ON_WS_CLOSE: 'false',
      MEDIA_TMP_DIR: '/tmp/zapo-rest-e2e-media',
    },
  },
})
