import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), '@skills': fileURLToPath(new URL('./skills', import.meta.url)) } },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
