// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

test('an ignored important keyframe font cannot conceal an animated off-scale font', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'parity-census-keyframe-'));
  try {
    const sheet = join(scratch, 'animated.css');
    const style =
      'font: var(--type-body); letter-spacing: var(--type-body-tracking); text-transform: var(--type-body-case);';
    const run = (frame: string) => {
      writeFileSync(
        sheet,
        `.x { ${style} animation: grow 1s; } @keyframes grow { from, to { ${frame} } }`,
      );
      return spawnSync(process.execPath, ['scripts/type-census.mjs', '--css', sheet], {
        cwd: root,
        encoding: 'utf8',
      });
    };
    const literal = 'font: 900 72px serif;';
    assert.equal(
      run(literal).status,
      1,
      'control: the ordinary off-scale keyframe font is refused',
    );
    // CSS ignores important declarations inside keyframes, so the ordinary font still applies.
    const frame = `${literal} font: var(--type-body) !important; letter-spacing: var(--type-body-tracking); text-transform: var(--type-body-case);`;
    const result = run(frame);
    assert.equal(
      result.status,
      1,
      `the ignored important declaration hides the effective literal font: ${result.stdout}${result.stderr}`,
    );
    assert.match(result.stderr, /900 72px serif/u);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);

test('parity inspects an imported browser worker that ships an uncatalogued request', () => {
  const copy = mkdtempSync(join(tmpdir(), 'parity-census-worker-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts'])
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const parity = () =>
      spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
        cwd: copy,
        encoding: 'utf8',
        timeout: 60_000,
      });
    const control = parity();
    assert.equal(control.status, 0, control.stdout + control.stderr);
    writeFileSync(
      join(copy, 'packages/browser-worker.mjs'),
      "fetch('/api/b/alpha/uncatalogued-write', { method: 'POST', body: '{}' });\n",
    );
    appendFileSync(
      join(copy, 'apps/web/src/main.tsx'),
      "\nimport PlantedWorker from '../../../packages/browser-worker.mjs?worker';\nnew PlantedWorker();\n",
    );
    // Independently verify that Vite emits an executable worker containing the request.
    const build = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { build } from 'vite';
      import react from '@vitejs/plugin-react';
      import { resolve } from 'node:path';
      const result = await build({ configFile: false, root: resolve('apps/web'), publicDir: false, logLevel: 'silent', plugins: [react()], resolve: { alias: { '@launchastro/ui': resolve('packages/ui/src/index.ts') } }, build: { write: false, minify: false } });
      const output = (Array.isArray(result) ? result : [result]).flatMap(one => one.output);
      if (!output.some(one => one.fileName.includes('browser-worker') && String(one.code ?? one.source).includes('uncatalogued-write'))) throw new Error('worker request was not emitted');
    `,
      ],
      { cwd: copy, encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const result = parity();
    assert.equal(result.status, 1, `parity accepts the shipped worker request: ${result.stderr}`);
    assert.match(result.stdout, /browser-worker\.mjs sends a request itself/u);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 180_000);

test('parity rejects task.update grant refusal removed while its query remains', () => {
  const copy = mkdtempSync(join(tmpdir(), 'parity-census-write-refusal-'));
  try {
    for (const directory of ['apps', 'packages', 'scripts'])
      cpSync(join(root, directory), join(copy, directory), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
    const parity = () =>
      spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
        cwd: copy,
        encoding: 'utf8',
        timeout: 60_000,
      });
    const refused = () => {
      const run = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { askedAgain } from './packages/core-commands/src/commands/prepare.ts';
        import { declarationOf } from './packages/core-wire/src/index.ts';
        let queries = 0;
        const tx = { businessId: '00000000-0000-4000-8000-000000000001', query: async () => { queries++; return []; } };
        const session = { personId: '00000000-0000-4000-8000-000000000002', actorId: '00000000-0000-4000-8000-000000000003', roleKey: 'member' };
        const result = await askedAgain(tx, { session, declaration: declarationOf('task.update') }, '00000000-0000-4000-8000-000000000004');
        process.stdout.write(JSON.stringify({ code: result?.refusal?.code ?? null, queries }));
      `,
        ],
        { cwd: copy, encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.equal(parity().status, 0, 'control: unchanged parity passes');
    assert.equal(refused().code, 'SCOPE_NOT_GRANTED', 'control: the real helper refuses no grants');
    const path = join(copy, 'packages/core-commands/src/commands/prepare.ts');
    const source = readFileSync(path, 'utf8');
    const mutant = source.replace(
      'if (authorised.ok) return {};',
      "if (authorised.ok || request.command === 'task.update') return {};",
    );
    assert.notEqual(mutant, source, 'the refusal mutation applied');
    writeFileSync(path, mutant);
    assert.deepEqual(
      refused(),
      { code: null, queries: 1 },
      'the real write helper admits task.update holding no grant, after querying',
    );
    const result = parity();
    assert.equal(
      result.status,
      1,
      `parity accepts task.update with its grant refusal removed: ${result.stderr}`,
    );
    assert.match(result.stdout, /task\.update/u);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 180_000);
