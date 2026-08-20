import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Vite's builtin list predates `node:sqlite`, so it tries to resolve it from
 * node_modules and fails. Hand it straight back as an external.
 */
const externalNodeSqlite = (): Plugin => ({
  name: 'externalize-node-sqlite',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'node:sqlite' || id === 'sqlite') return { id: 'node:sqlite', external: true };
    return null;
  },
});

export default defineConfig({
  plugins: [externalNodeSqlite()],
  resolve: {
    // Point workspace imports at source so tests never need a build step.
    alias: { '@ccx/shared': src('shared'), '@ccx/ai': src('ai') },
  },
  test: {
    server: {
      // Belt and braces: keep every node: builtin out of the transform pipeline.
      deps: { external: [/^node:/] },
    },
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
