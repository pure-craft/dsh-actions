import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The client spec never renders; alias the render-chain packages to
      // inert stubs instead of dragging their dependency trees (css,
      // react-dom, icon sets) into the test runtime.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/stubs/primitives.ts', import.meta.url)),
      '@iconify/react': fileURLToPath(new URL('./tests/stubs/iconify-react.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['.references/**', 'node_modules/**', 'lib/**'],
    coverage: {
      provider: 'v8',
      include: ['src/wire.ts', 'src/host/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
