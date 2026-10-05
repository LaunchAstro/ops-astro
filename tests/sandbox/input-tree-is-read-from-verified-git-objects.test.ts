// SPDX-License-Identifier: AGPL-3.0-only
//
// I2 (docs/plan/sandbox-contract.md, section 3): the launcher assembles the
// input tree in memory from the site repository's git objects at
// `baseRevision`, read one object at a time through the broker. Every
// object's bytes must hash to its git object id (the commit, each tree and
// each blob), so a broker that drops a listing entry or changes a byte is
// refused; a tree object that ends inside an entry, or a commit that does
// not open with its tree, is a refusal; a symlink or submodule is refused
// before anything under it is read; the I3 caps stop the reads as soon as
// they are passed. The changed file replaces a regular file at
// `baseRevision`, and the edited tree is judged by I3. The fixtures are made
// by git itself.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assembleTree, type GitRead } from '../../packages/core-sandbox/src/git-tree.ts';

let repo = '';
const git = (args: readonly string[], input?: string | Buffer): Buffer =>
  execFileSync('git', ['-C', repo, ...args], { input, maxBuffer: 256 * 1024 * 1024 });
const text = (args: readonly string[], input?: string | Buffer) =>
  git(args, input).toString().trim();
const blob = (content: string | Buffer) => text(['hash-object', '-w', '--stdin'], content);
/** A raw object git stores as given, valid or not, and its id. */
const literal = (type: string, content: Buffer) =>
  text(['hash-object', '-t', type, '-w', '--literally', '--stdin'], content);
/** A tree from `mode oid path` rows, via git's own index. */
function tree(rows: readonly string[]): string {
  const index = join(repo, `index-${String(Math.random()).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const lines = rows.map((row) => {
    const [mode, oid, path] = row.split(' ');
    return `${mode ?? ''} ${mode === '160000' ? 'commit' : 'blob'} ${oid ?? ''}\t${path ?? ''}\n`;
  });
  execFileSync('git', ['-C', repo, 'update-index', '--index-info'], { input: lines.join(''), env });
  const id = execFileSync('git', ['-C', repo, 'write-tree'], { env }).toString().trim();
  rmSync(index);
  return id;
}
/** One tree level from `mode oid name` rows, any object type, via git mktree. */
const typeOf = (mode: string) =>
  mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
function level(rows: readonly string[]): string {
  const lines = rows.map((row) => {
    const [mode = '', oid = '', name = ''] = row.split(' ');
    return `${mode} ${typeOf(mode)} ${oid}\t${name}\n`;
  });
  return text(['mktree', '--missing'], lines.join(''));
}
const commit = (treeId: string) => text(['commit-tree', treeId, '-m', 'site']);
/** The offset where each entry of a raw tree object starts. */
function entryStarts(raw: Uint8Array): number[] {
  const starts: number[] = [];
  for (let at = 0; at < raw.length; at = raw.indexOf(0, at) + 21) starts.push(at);
  return starts;
}

let reads: string[] = [];
/** The broker's read: an object's raw bytes, as git stores them. */
const read: GitRead = (oid) => {
  reads.push(oid);
  const type = text(['cat-file', '-t', oid]);
  return Promise.resolve(new Uint8Array(git(['cat-file', type, oid])));
};
const bytes = (value: string) => new TextEncoder().encode(value);
const refused = (why: string) => ({ ok: false, reason: 'input refused', why });
const allRefused = async (results: readonly Promise<unknown>[], why: string) => {
  expect(await Promise.all(results)).toEqual(results.map(() => refused(why)));
};
const EDIT = { path: 'src/pages/index.astro', content: bytes('<h1>New</h1>\n') };

let SITE_FILES: string[] = [];
let siteCommit = '';
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-tree-'));
  execFileSync('git', ['init', '-q', '--bare', repo]);
  process.env['GIT_AUTHOR_NAME'] = 'Test';
  process.env['GIT_AUTHOR_EMAIL'] = 'test@example.invalid';
  process.env['GIT_COMMITTER_NAME'] = 'Test';
  process.env['GIT_COMMITTER_EMAIL'] = 'test@example.invalid';
  SITE_FILES = [
    `100644 ${blob('{"name":"site"}')} package.json`,
    `100644 ${blob('{"lockfileVersion":3}')} package-lock.json`,
    `100644 ${blob('<h1>Old</h1>\n')} src/pages/index.astro`,
    `100755 ${blob('#!/bin/sh\n')} scripts/build.sh`,
  ];
  siteCommit = commit(tree(SITE_FILES));
}, 60_000);
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});
const assemble = (rows: readonly string[], edit = EDIT) => {
  reads = [];
  return assembleTree(read, commit(tree(rows)), edit);
};

it('assembles the tree at baseRevision with the changed file in place', async () => {
  reads = [];
  const result = await assembleTree(read, siteCommit, EDIT);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect([...result.files.keys()].toSorted()).toEqual([
    'package-lock.json',
    'package.json',
    'scripts/build.sh',
    'src/pages/index.astro',
  ]);
  expect(new TextDecoder().decode(result.files.get('src/pages/index.astro'))).toBe(
    '<h1>New</h1>\n',
  );
  expect(new TextDecoder().decode(result.files.get('package.json'))).toBe('{"name":"site"}');
  expect(result.entries).toContainEqual({ path: 'scripts/build.sh', mode: '100755', size: 10 });
  expect(result.entries).toContainEqual({ path: 'src/pages', mode: '040000', size: 0 });
});

it('refuses an object whose bytes do not hash to its id', async () => {
  const tamper =
    (pick: (oid: string, raw: Uint8Array) => Uint8Array): GitRead =>
    async (oid, maxBytes) =>
      pick(oid, await read(oid, maxBytes));
  const dropLastEntry: GitRead = tamper((oid, raw) =>
    text(['cat-file', '-t', oid]) === 'tree' ? raw.slice(0, entryStarts(raw).at(-1)) : raw,
  );
  const flipBlob: GitRead = tamper((oid, raw) =>
    text(['cat-file', '-t', oid]) === 'blob'
      ? Uint8Array.from(raw, (b, n) => (n === 0 ? b ^ 1 : b))
      : raw,
  );
  const otherCommit: GitRead = (oid, maxBytes) =>
    oid === siteCommit ? read(commit(tree(SITE_FILES.slice(1))), maxBytes) : read(oid, maxBytes);
  await allRefused(
    [dropLastEntry, flipBlob, otherCommit].map((broker) => assembleTree(broker, siteCommit, EDIT)),
    'tree object',
  );
});

it('refuses a tree object that ends inside an entry and a commit that does not open with its tree', async () => {
  const good = Buffer.from(git(['cat-file', 'tree', tree(SITE_FILES.slice(0, 1))]));
  const cutTops = [1, 7, good.length - 1].map((cut) =>
    commit(level([`040000 ${literal('tree', good.subarray(0, cut))} src`])),
  );
  const treeId = tree(SITE_FILES);
  const badCommits = [
    `parent ${'a'.repeat(40)}\ntree ${treeId}\n`,
    `tree ${treeId.toUpperCase()}\n`,
    `tree ${treeId}`,
  ].map((body) => literal('commit', Buffer.from(body)));
  await allRefused(
    [...cutTops, ...badCommits].map((top) => assembleTree(read, top, EDIT)),
    'tree listing',
  );
});

it('refuses a symlink or a submodule without reading what it points at', async () => {
  const target = blob('/etc/passwd');
  expect(await assemble([...SITE_FILES, `120000 ${target} src/pages/link.astro`])).toEqual(
    refused('tree type'),
  );
  expect(reads).not.toContain(target);
  expect(await assemble([...SITE_FILES, `160000 ${siteCommit} vendor`])).toEqual(
    refused('tree type'),
  );
});

it('refuses a name that is not UTF-8 or that holds a slash', async () => {
  const fileId = blob('x');
  const raw = (name: Buffer) =>
    Buffer.concat([Buffer.from('100644 '), name, Buffer.from([0]), Buffer.from(fileId, 'hex')]);
  const tops = [Buffer.from([0x61, 0xff]), Buffer.from('a/b'), Buffer.from('')].map((name) =>
    commit(level([`040000 ${literal('tree', raw(name))} src`])),
  );
  await allRefused(
    tops.map((top) => assembleTree(read, top, EDIT)),
    'tree name',
  );
});

it('stops at 20,001 entries before reading any blob', async () => {
  const one = blob('x');
  const rows = Array.from({ length: 20_001 }, (_, n) => `100644 ${one} f${String(n)}.md`);
  expect(await assemble(rows)).toEqual(refused('tree entries'));
  expect(reads).not.toContain(one);
}, 60_000);

it('stops reading once the blobs pass 50 MB', async () => {
  const half = blob(Buffer.alloc(25_000_000, 0x61));
  const over = blob(Buffer.alloc(25_000_001, 0x62));
  const after = blob('z');
  const budgets = new Map<string, number>();
  const counting: GitRead = (oid, maxBytes) => {
    budgets.set(oid, maxBytes);
    return read(oid, maxBytes);
  };
  reads = [];
  const top = commit(
    tree([`100644 ${half} a.md`, `100644 ${over} b.md`, `100644 ${after} c.md`, ...SITE_FILES]),
  );
  expect(await assembleTree(counting, top, EDIT)).toEqual(refused('tree size'));
  expect(reads).not.toContain(after);
  expect(budgets.get(half)).toBe(50_000_000);
  expect(budgets.get(over)).toBe(25_000_000);
}, 60_000);

it('refuses a changed path that is not a regular file at baseRevision', async () => {
  await allRefused(
    ['src/pages/new.astro', 'src/pages', 'src'].map((path) =>
      assemble(SITE_FILES, { ...EDIT, path }),
    ),
    'request path',
  );
});

it('judges the edited tree by I3', async () => {
  expect(await assemble([...SITE_FILES, `100644 ${blob('x')} .npmrc`])).toEqual(
    refused('tree config'),
  );
  expect(await assemble([...SITE_FILES, `100644 ${blob('x')} SRC/pages/index.astro`])).toEqual(
    refused('tree duplicate'),
  );
});

it('refuses a name over 255 bytes and a path over 4,096 bytes', async () => {
  const fileId = blob('x');
  const longName = commit(level([`100644 ${fileId} ${'a'.repeat(256)}.md`]));
  const deep = Array.from(
    { length: 17 },
    (_, n) => `${String(n).padStart(2, '0')}${'d'.repeat(253)}`,
  );
  let nested = level([`100644 ${fileId} a.md`]);
  for (const name of deep.toReversed()) nested = level([`040000 ${nested} ${name}`]);
  await allRefused(
    [assembleTree(read, longName, EDIT), assembleTree(read, commit(nested), EDIT)],
    'tree name',
  );
  const fits = commit(level([`100644 ${fileId} ${'a'.repeat(252)}.md`]));
  const result = await assembleTree(read, fits, { ...EDIT, path: `${'a'.repeat(252)}.md` });
  expect(result.ok).toBe(true);
});

it('refuses a .git directory in the tree', async () => {
  const gitDirectory = level([`100644 ${blob('[core]\n\tfsmonitor = sh -c id\n')} config`]);
  const page = blob('<h1>Old</h1>\n');
  const tops = ['.git', 'GIT~1'].map((name) =>
    commit(level([`040000 ${gitDirectory} ${name}`, `100644 ${page} index.md`])),
  );
  await allRefused(
    tops.map((top) => assembleTree(read, top, { ...EDIT, path: 'index.md' })),
    'tree config',
  );
});
