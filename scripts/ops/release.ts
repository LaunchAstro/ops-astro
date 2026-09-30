// SPDX-License-Identifier: AGPL-3.0-only
//
// The release step (tickets S0-1 and S0-6, the Vercel re-plan): the web app and
// its API as one build output in Vercel's Build Output API layout, version 3,
// built once and deployed as it is to staging and then production
// (`vercel deploy --prebuilt`).
//
//   node scripts/ops/release.ts [--dist apps/web/dist] [--out .vercel/output]
//
// - `static/`: the web build as `pnpm build` wrote it, stamped (`build.json`).
// - `functions/api.func/`: `apps/api/function.ts` bundled into one module, a
//   Node.js function pinned to Sydney (`syd1`), nothing on the edge runtime.
// - `config.json`: every `/api` answer sent `private, no-store`; `/api` goes to
//   the function before any static file is looked for, so none can shadow it,
//   and every other path to a static file, so no page response is made from
//   records. No middleware, nothing prerendered.
// - `build.json` at the root: the web build's stamp and the output's digest,
//   so a deploy and a promotion can check they hold the same bytes. The
//   digest covers every file, `build.json` included without its own digest.
//
// No environment value is read into the output: the function reads its
// settings when it runs. The output is checked with `buildOutputProblems`
// before this step reports it; a problem fails the release.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { buildOutputProblems, outputDigest, stampOutput } from './build-output.ts';

export { outputDigest };

const ROOT = resolve(import.meta.dirname, '../..');
const NO_STORE = { 'cache-control': 'private, no-store' };
const FUNCTION = {
  runtime: 'nodejs24.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  regions: ['syd1'],
  supportsResponseStreaming: true,
};
const CONFIG = {
  version: 3,
  routes: [
    { src: '^/api(?:/.*)?$', headers: NO_STORE, continue: true },
    { src: '^/api(?:/.*)?$', dest: '/api' },
    { handle: 'filesystem' },
    { src: '^/.*$', dest: '/index.html' },
  ],
};

/** What a release records: the web build's stamp and the output's digest. */
export interface Release {
  readonly build: string;
  readonly digest: string;
}

/** Writes the build output at `out` from the stamped web build at `dist`. */
export async function release({ dist, out }: { dist: string; out: string }): Promise<Release> {
  const { build: stamp } = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8')) as {
    build?: unknown;
  };
  if (typeof stamp !== 'string' || stamp === '') throw new Error('the web build is not stamped');
  rmSync(out, { recursive: true, force: true });
  cpSync(dist, join(out, 'static'), { recursive: true });
  const func = join(out, 'functions', 'api.func');
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: join(ROOT, 'apps/api/function.ts'),
      outDir: func,
      emptyOutDir: false,
      minify: false,
      target: 'node24',
      rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } },
    },
  });
  writeFileSync(join(func, '.vc-config.json'), JSON.stringify(FUNCTION, null, 2));
  writeFileSync(join(out, 'config.json'), JSON.stringify(CONFIG, null, 2));
  const problems = buildOutputProblems(out);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return stampOutput(out, stamp);
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dist: { type: 'string' }, out: { type: 'string' } } });
  const dist = resolve(values.dist ?? join(ROOT, 'apps/web/dist'));
  const out = resolve(values.out ?? join(ROOT, '.vercel/output'));
  mkdirSync(out, { recursive: true });
  try {
    const record = await release({ dist, out });
    console.log(`release: ${record.build} ${record.digest}`);
  } catch (error) {
    console.error(`release: refused: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
