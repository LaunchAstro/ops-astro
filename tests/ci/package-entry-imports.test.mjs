// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const base = 'cf802d63e6016133250a1a3b3515c0de35bcc123';
// CQ-4's own change ends at its merged head. Later tickets rename and edit
// tests, so the body comparison reads that head rather than the tree.
const head = '7df17eb3e2e49ed1a195c3aefcfec18d0a06503c';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const withoutImports = (source) => source.replaceAll(/^import\s[\s\S]*?;\n/gmu, '');

test('production imports enter each package through its index', () => {
  for (const path of [
    'apps/cli/client.ts',
    'apps/cli/main.ts',
    'apps/web/src/operations/client.ts',
    'apps/web/src/records/submit.ts',
  ]) {
    assert.equal(
      /from\s*['"][^'"]*packages\/core-commands\/src\/(?!index\.ts)[^'"]+['"]/u.test(read(path)),
      false,
      `${path} reaches past the command package index`,
    );
  }
});

test('CSS imports also enter packages through their index', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sol-cq4-css-'));
  try {
    for (const path of ['apps/web/src', 'packages/ui/src']) {
      mkdirSync(join(fixture, path), { recursive: true });
    }
    writeFileSync(join(fixture, '.dependency-cruiser.cjs'), read('.dependency-cruiser.cjs'));
    writeFileSync(
      join(fixture, 'apps/web/src/main.tsx'),
      "import '../../../packages/ui/src/styles.css';\nexport const app = 1;\n",
    );
    writeFileSync(join(fixture, 'packages/ui/src/styles.css'), 'body { color: black; }\n');
    writeFileSync(join(fixture, 'packages/ui/src/index.ts'), 'export const ui = 1;\n');
    const run = spawnSync(
      process.execPath,
      [join(root, 'scripts/deps-cruise.mjs'), 'apps', 'packages'],
      {
        encoding: 'utf8',
        env: { ...process.env, DEPS_CRUISE_ROOT: fixture },
      },
    );
    assert.equal(
      run.status === 1 && /index-only/u.test(run.stderr),
      true,
      `deps:cruise did not reject the CSS import by index-only (status ${String(run.status)}; ${run.stderr.trim()})`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.equal(
    /import\s*['"][^'"]*packages\/ui\/src\/styles\/[^'"]+\.css['"]/u.test(
      read('apps/web/src/main.tsx'),
    ),
    false,
    'the web imports UI CSS directly from another package src/ path',
  );
});

test('existing test bodies change only at moved source paths', () => {
  const renames = git(
    'diff',
    '--find-renames=50%',
    '--name-status',
    `${base}...${head}`,
    '--',
    'packages',
  )
    .trim()
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([status]) => status?.startsWith('R'))
    .map(([, from, to]) => [from, to]);
  const changed = git('diff', '--name-only', `${base}...${head}`, '--', 'tests')
    .trim()
    .split('\n')
    .filter((path) => /\.test\.(?:ts|tsx|js|mjs)$/u.test(path));

  for (const path of changed) {
    const existed =
      spawnSync('git', ['cat-file', '-e', `${base}:${path}`], {
        cwd: root,
        stdio: 'ignore',
      }).status === 0;
    // New tests have no earlier body to preserve.
    if (!existed) continue;
    let before = git('show', `${base}:${path}`);
    for (const [from, to] of renames) before = before.replaceAll(from, to);
    // This directory constant names the moved command sources; the register
    // moved separately into records, so its template path becomes a literal.
    before = before
      .replaceAll('packages/core-records/src/commands', 'packages/core-commands/src/commands')
      .replaceAll('commands/register.ts', 'core-records/src/register.ts')
      .replaceAll('read(`${C}/register.ts`)', "read('packages/core-records/src/register.ts')");
    assert.equal(
      withoutImports(git('show', `${head}:${path}`)),
      withoutImports(before),
      `${path} changed outside imports and paths to moved source files`,
    );
  }
});
