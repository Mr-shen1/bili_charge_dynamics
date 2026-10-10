import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  resolve: { alias: { '#assembly': fileURLToPath(new URL(
    command === 'serve' && mode === 'fault' ? './src/dev/assembly.ts' : './src/data/assembly.ts', import.meta.url,
  )) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
}));
