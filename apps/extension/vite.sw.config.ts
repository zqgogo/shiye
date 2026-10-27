import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * service worker 单独构建：不引用页面 chunk，避免在 worker 里加载 UI 代码。
 * 输出为自包含的 ESM，manifest 声明 type: module。
 */
export default defineConfig({
  root: path('.'),
  publicDir: false,
  resolve: {
    alias: {
      '@shiye/core': path('../../packages/core/src/index.ts'),
      '@shiye/application': path('../../packages/application/src/index.ts'),
      '@shiye/storage': path('../../packages/storage/src/index.ts'),
      '@shiye/ai-adapter': path('../../packages/adapters/ai/src/index.ts'),
      '@shiye/workspace': path('../workspace/src/index.tsx'),
    },
  },
  build: {
    outDir: path('./dist'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'chrome110',
    minify: 'esbuild',
    lib: {
      entry: path('./src/background/service-worker.ts'),
      formats: ['es'],
      fileName: () => 'service-worker.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
