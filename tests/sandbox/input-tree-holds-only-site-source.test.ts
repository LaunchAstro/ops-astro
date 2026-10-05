// SPDX-License-Identifier: AGPL-3.0-only
//
// I3 (docs/plan/sandbox-contract.md, section 3) as a closed grammar over the
// git tree listing at `baseRevision`: at most 20,000 entries and 50 MB of
// blob bytes; regular files (100644, 100755) and directories (040000) only,
// so no symlink (120000), submodule (160000) or any other mode; every name
// segment in O1's character set plus `[` and `]`, which leaves only ASCII
// (NFC by construction), never `.` or `..`, unique after ASCII case folding;
// no `node_modules`, `dist`, `.astro`, `.vercel` or `.netlify` segment at any
// depth; and no package manager or git configuration file anywhere.

import { expect, it } from 'vitest';
import { checkTree, type TreeEntry } from '../../packages/core-sandbox/src/input-tree.ts';

const refused = (why: string) => ({ ok: false, reason: 'input refused', why });
const file = (path: string, size = 10, mode = '100644'): TreeEntry => ({ path, mode, size });
const dir = (path: string): TreeEntry => ({ path, mode: '040000', size: 0 });

const SITE: readonly TreeEntry[] = [
  file('package.json'),
  file('package-lock.json'),
  file('astro.config.mjs'),
  dir('src'),
  dir('src/pages'),
  file('src/pages/index.astro'),
  dir('src/pages/blog'),
  file('src/pages/blog/[slug].astro'),
  file('scripts/build.sh', 10, '100755'),
];
const withEntry = (...extra: TreeEntry[]) => checkTree([...SITE, ...extra]);

it('accepts a site tree of regular files and directories with dynamic route names', () => {
  expect(checkTree(SITE)).toEqual({ ok: true });
});

it('holds the tree to 20,000 entries', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, n) => file(`f${String(n)}.md`, 1));
  expect(checkTree(many(20_000))).toEqual({ ok: true });
  expect(checkTree(many(20_001))).toEqual(refused('tree entries'));
});

it('holds the tree to 50 MB of blob bytes', () => {
  expect(checkTree([file('a.md', 25_000_000), file('b.md', 25_000_000)])).toEqual({ ok: true });
  expect(checkTree([file('a.md', 25_000_000), file('b.md', 25_000_001)])).toEqual(
    refused('tree size'),
  );
});

it('refuses every mode but a regular file or a directory', () => {
  for (const mode of ['120000', '160000', '100664', '040755', '', '100644 ']) {
    expect(withEntry(file('src/pages/x.astro', 10, mode)), mode).toEqual(refused('tree type'));
  }
});

it('refuses a name outside the character set, including any non-ASCII byte', () => {
  for (const path of [
    'src/pages/a b.astro',
    'src/pages/a\\b.astro',
    'src/pages/é.astro',
    'src/pages/é.astro',
    'src/pages/a:b.astro',
    'src/pages/a\u0000.astro',
    'src/pages/{x}.astro',
  ]) {
    expect(withEntry(file(path)), path).toEqual(refused('tree name'));
  }
});

it('refuses an empty, dot or dot-dot segment and a leading or trailing slash', () => {
  for (const path of ['src//a.md', 'src/./a.md', 'src/../a.md', '/a.md', 'src/a.md/', '', '.']) {
    expect(withEntry(file(path)), path).toEqual(refused('tree name'));
  }
});

it('refuses two names equal after ASCII case folding, and the same name twice', () => {
  expect(withEntry(file('src/pages/INDEX.astro'))).toEqual(refused('tree duplicate'));
  expect(withEntry(file('src/pages/index.astro'))).toEqual(refused('tree duplicate'));
  expect(withEntry(dir('SRC'))).toEqual(refused('tree duplicate'));
});

it('refuses a build output or tool directory at any depth, as a file or a directory', () => {
  for (const name of ['node_modules', 'dist', '.astro', '.vercel', '.netlify']) {
    expect(withEntry(dir(name)), name).toEqual(refused('tree reserved'));
    expect(withEntry(file(`src/pages/${name}`)), name).toEqual(refused('tree reserved'));
    expect(withEntry(file(`src/${name}/a.md`)), name).toEqual(refused('tree reserved'));
  }
  expect(withEntry(file('src/pages/distance.astro'))).toEqual({ ok: true });
});

it('refuses a package manager or git configuration file anywhere', () => {
  for (const name of [
    '.gitattributes',
    '.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmfile.cjs',
  ]) {
    expect(withEntry(file(name)), name).toEqual(refused('tree config'));
    expect(withEntry(file(`src/content/${name}`)), name).toEqual(refused('tree config'));
  }
  expect(withEntry(file('src/content/.npmrc.md'))).toEqual({ ok: true });
});

it('refuses a size that is not a whole number of bytes', () => {
  for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(withEntry(file('src/pages/x.astro', size)), String(size)).toEqual(refused('tree size'));
  }
});

it('refuses a .git entry in any spelling git itself refuses to check out', () => {
  for (const path of [
    '.git/config',
    'src/.git',
    '.GIT/config',
    '.git./config',
    '.git../x',
    'GIT~1/config',
    'src/git~1',
  ])
    expect(withEntry(file(path))).toEqual(refused('tree config'));
  for (const path of ['.github/workflows/a.md', 'src/.gitkeep', 'git~2.md', 'src/x.git'])
    expect(withEntry(file(path))).toEqual({ ok: true });
});
