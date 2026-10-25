import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '.'),
      // Empty under Next's react-server condition, which Vitest doesn't set. See test/stubs/server-only.ts.
      'server-only': path.resolve(import.meta.dirname, 'test/stubs/server-only.ts'),
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
