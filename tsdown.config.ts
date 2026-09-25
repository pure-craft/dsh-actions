import { defineConfig } from 'tsdown';

const packageId = 'dsh-actions';

export default defineConfig([
  {
    name: packageId,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: { sourcemap: true },
    sourcemap: true,
    clean: true,
    external: [/^@deepseek-ai\//, 'react', /^react\//],
  },
  {
    name: `${packageId}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    external: [
      'react',
      /^react\//,
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    // DSH's browser loader only materializes platform packages. tsdown
    // externalizes production dependencies by default, so bundle every
    // third-party runtime that the client graph reaches.
    noExternal: ['zod', '@iconify/react'],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    sourcemap: true,
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
]);
