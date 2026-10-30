import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const repoRoot = path('../../');

export default defineConfig({
  root: path('.'),
  publicDir: path('./public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shiye/core': path('../../packages/core/src/index.ts'),
      '@shiye/application': path('../../packages/application/src/index.ts'),
      '@shiye/storage': path('../../packages/storage/src/index.ts'),
      '@shiye/ai-adapter': path('../../packages/adapters/ai/src/index.ts'),
      '@shiye/workspace': path('../workspace/src/index.tsx'),
    },
  },
  server: {
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: path('./dist'),
    emptyOutDir: true,
    target: 'chrome110',
    sourcemap: false,
    rollupOptions: {
      input: {
        workspace: path('./workspace.html'),
        popup: path('./popup.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
