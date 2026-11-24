import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs API tests with the operator token configured (#160).
    setupFiles: ['./src/test-setup.ts'],
  },
});
