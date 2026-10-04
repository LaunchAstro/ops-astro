// SPDX-License-Identifier: AGPL-3.0-only
// The per-area lists under tests/db/named-suites/ and tests/db/isolation-suites.json
// were still files most pull requests edited: 12 of the 23 merges to main from
// 3 October touched them (MERGE-PLAN item 5, ORCH91 MAGNETS step 1). So each
// named suite gets a file of its own under tests/db/suites/, at the suite's
// path below tests/, and the readers read the folder. Two pull requests that
// add suites then add two files and never touch the same one. This proves
// the conversion of the real lists loses nothing, the reader refuses a file it
// cannot trust and names it, and a suite dropped from the manifest is caught
// unless its test file went with it.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { readIsolationSuites, readNamedSuites, suitesToFiles } from '../../scripts/named-suites.ts';
import { droppedSuites } from '../../scripts/suite-files.ts';

const ROOT = join(import.meta.dirname, '../..');
const AREAS = 'tests/db/named-suites';
const ISOLATION = 'tests/db/isolation-suites.json';
const SUITES = 'tests/db/suites';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'suite-files-'));
  made.push(root);
  mkdirSync(join(root, 'tests/db'), { recursive: true });
  return root;
}

/** A root whose per-suite folder holds these files: a string is written as is, anything else as JSON. */
function suites(files: Record<string, unknown>): string {
  const root = tempRoot();
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, SUITES, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function refused(files: Record<string, unknown>, file: string, reason: RegExp): void {
  const read = () => readNamedSuites(suites(files));
  expect(read).toThrow(reason);
  expect(read).toThrow(`${SUITES}/${file}`);
}

const sorted = (list: readonly string[]) => list.toSorted();

it('converts the real lists and reads back the same suites, each once, the isolation set and the history', () => {
  const before = readNamedSuites(ROOT);
  const isolationBefore = readIsolationSuites(ROOT);
  const root = tempRoot();
  cpSync(join(ROOT, AREAS), join(root, AREAS), { recursive: true });
  cpSync(join(ROOT, ISOLATION), join(root, ISOLATION));
  suitesToFiles(root);
  expect(existsSync(join(root, AREAS))).toBe(false);
  expect(existsSync(join(root, ISOLATION))).toBe(false);
  const after = readNamedSuites(root);
  expect(sorted(after.invariant)).toStrictEqual(sorted(before.invariant));
  expect(sorted(after.conformance)).toStrictEqual(sorted(before.conformance));
  expect(new Set([...after.invariant, ...after.conformance]).size).toBe(
    before.invariant.length + before.conformance.length,
  );
  expect(sorted(readIsolationSuites(root).invariant)).toStrictEqual(
    sorted(isolationBefore.invariant),
  );
  expect(after.comment).toStrictEqual(before.comment);
});

it("reads a suite's path from where its file sits, and its kind and isolation from the file", () => {
  const root = suites({
    'api/a.test.ts.json': { kind: 'invariant', isolation: true, why: 'the crossing' },
    'runtime/deep/b.test.tsx.json': { kind: 'conformance', isolation: true, why: 'a contract' },
  });
  expect(readNamedSuites(root)).toStrictEqual({
    comment: [],
    invariant: ['tests/api/a.test.ts'],
    conformance: ['tests/runtime/deep/b.test.tsx'],
  });
  expect(readIsolationSuites(root)).toStrictEqual({
    invariant: ['tests/api/a.test.ts', 'tests/runtime/deep/b.test.tsx'],
  });
});

it('refuses a suite file it cannot trust, and names it', () => {
  const ok = { kind: 'invariant', isolation: false, why: 'w' };
  refused({ 'api/a.test.ts.json': { ...ok, extra: 1 } }, 'api/a.test.ts.json', /unknown key/u);
  refused({ 'api/a.test.ts.json': { ...ok, kind: 'other' } }, 'api/a.test.ts.json', /kind/u);
  refused(
    { 'api/a.test.ts.json': { ...ok, isolation: 'yes' } },
    'api/a.test.ts.json',
    /isolation/u,
  );
  refused({ 'api/a.test.ts.json': { ...ok, why: '' } }, 'api/a.test.ts.json', /why/u);
  refused({ 'api/a.test.ts.json': '{not json' }, 'api/a.test.ts.json', /not valid JSON/u);
  refused({ 'api/a.test.ts': ok }, 'api/a.test.ts', /\.json/u);
});

it('refuses a tree that holds the old lists beside the per-suite folder', () => {
  const root = suites({ 'api/a.test.ts.json': { kind: 'invariant', isolation: false, why: 'w' } });
  mkdirSync(join(root, AREAS));
  expect(() => readNamedSuites(root)).toThrow(AREAS);
  const other = suites({ 'api/a.test.ts.json': { kind: 'invariant', isolation: false, why: 'w' } });
  writeFileSync(join(other, ISOLATION), '{"invariant":[]}');
  expect(() => readIsolationSuites(other)).toThrow(ISOLATION);
});

it('names a suite the head dropped, unless its test file was deleted in the same change', () => {
  const base = ['tests/api/a.test.ts', 'tests/api/b.test.ts', 'tests/api/c.test.ts'];
  expect(droppedSuites(base, ['tests/api/a.test.ts'], ['tests/api/c.test.ts'])).toStrictEqual([
    'tests/api/b.test.ts',
  ]);
  expect(droppedSuites(base, [...base, 'tests/api/d.test.ts'], [])).toStrictEqual([]);
});
