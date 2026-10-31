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
    // 多个 worker 同时载入 fake-indexeddb 时，内存紧张的机器会被系统杀掉子进程，
    // 表现为 tinypool「Worker exited unexpectedly」而不是用例失败。整套串行只要 2–3 秒，
    // 直接关掉文件级并行，换取「跑不通就是真失败」的确定性。
    fileParallelism: false,
  },
});
