/**
 * Bundles the server into a single ESM file.
 *
 * The point is the container: with everything inlined, the runtime image is a
 * Node base plus one file and the client's static assets — no `node_modules`, no
 * workspace symlinks to reproduce, and nothing to `npm ci` at deploy time.
 *
 * Run with `npm run bundle -w @ccx/server` (after `npm run build`).
 */
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  // `ws` is CommonJS and calls require() for Node builtins. ESM output has no
  // require, so give it one.
  banner: {
    js: [
      "import { createRequire as __ccxCreateRequire } from 'node:module';",
      'const require = __ccxCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  external: [
    // Optional native accelerators for `ws`; absent by design.
    'bufferutil',
    'utf-8-validate',
    // Built in to Node, and loaded through createRequire at runtime.
    'node:sqlite',
  ],
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)
  .reduce((total, output) => total + output.bytes, 0);
console.log(`bundled server: ${(bytes / 1024).toFixed(0)} kB`);
