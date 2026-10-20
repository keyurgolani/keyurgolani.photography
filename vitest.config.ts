import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // e2e/ is Playwright's. Standalone output tracing copies test files into .next/standalone.
    exclude: [...configDefaults.exclude, 'e2e/**', '.next/**'],
  },
});
