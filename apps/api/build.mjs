// Production build: bundles each process entry point into dist/ with esbuild.
// - TypeScript is compiled away (no tsx needed in production)
// - @alertly/shared (TypeScript source) is bundled IN
// - real npm dependencies stay external and load from node_modules (native modules like
//   argon2 can't be bundled anyway)
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((name) => name !== '@alertly/shared');

await build({
  entryPoints: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    scheduler: 'src/scheduler.ts',
    migrate: 'src/cli/migrate.ts',
    seed: 'src/cli/seed.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
});
