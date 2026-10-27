import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shiye/core': resolvePath('./packages/core/src/index.ts'),
      '@shiye/application': resolvePath('./packages/application/src/index.ts'),
      '@shiye/storage': resolvePath('./packages/storage/src/index.ts'),
      '@shiye/ai-adapter': resolvePath('./packages/adapters/ai/src/index.ts'),
      '@shiye/workspace': resolvePath('./apps/workspace/src/index.tsx'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
      testTimeout: 20000,
  },
});
