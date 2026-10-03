// SPDX-License-Identifier: AGPL-3.0-only
// tests/db/named-suites.json is a file every lane edits, so it is split into
// one file per area under tests/db/named-suites/ (code-factory METHOD Phase 2
// step 6). This proves the split of the real manifest loses nothing, the
// reader refuses a folder it cannot trust and names the file, and with no
// folder the readers get the single file's lists exactly as before. The cut
// removed the single file, so "the real manifest" is the cut parent's copy.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, resolveConfig } from 'prettier';
import { afterAll, expect, it } from 'vitest';
import { readNamedSuites, splitNamedSuites, splitToFolder } from '../../scripts/named-suites.ts';

const ROOT = join(import.meta.dirname, '../..');
const SINGLE = 'tests/db/named-suites.json';
const FOLDER = 'tests/db/named-suites';
/** The commit the cut was made from (main 3a90a92, #341): the last one that held the single file. */
const CUT_PARENT = '3a90a92f8f4deab5bf64af2b8b830c911a6fbbb2';
const realText = execFileSync('git', ['show', `${CUT_PARENT}:${SINGLE}`], {
  cwd: ROOT,
  encoding: 'utf8',
});
const real = JSON.parse(realText) as {
  comment: string[];
  invariant: string[];
  conformance: string[];
};

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(single?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'named-suites-'));
  made.push(root);
  mkdirSync(join(root, 'tests/db'), { recursive: true });
  if (single !== undefined) writeFileSync(join(root, SINGLE), single);
  return root;
}

/** A root whose folder holds these files: a string is written as is, anything else as JSON. */
function folder(files: Record<string, unknown>): string {
  const root = tempRoot();
  mkdirSync(join(root, FOLDER));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, FOLDER, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function refused(files: Record<string, unknown>, file: string, reason: RegExp): void {
  const read = () => readNamedSuites(folder(files));
  expect(read).toThrow(reason);
  expect(read).toThrow(`${FOLDER}/${file}`);
}

const API = 'tests/api/a.test.ts';
const RUNTIME = 'tests/runtime/b.test.ts';

it('splits the real manifest and reads back the same suites, each once, and every comment line', async () => {
  const root = tempRoot(realText);
  await splitToFolder(root);
  const joined = readNamedSuites(root);
  expect(joined.comment).toStrictEqual(real.comment);
  expect(joined.invariant).toStrictEqual(real.invariant.toSorted());
  expect(joined.conformance).toStrictEqual(real.conformance.toSorted());
  expect(new Set([...joined.invariant, ...joined.conformance]).size).toBe(
    real.invariant.length + real.conformance.length,
  );
  expect(existsSync(join(root, SINGLE)), 'the single file is replaced by the folder').toBe(false);
  const files = readdirSync(join(root, FOLDER));
  expect(files).toContain('_history.json');
  expect(files).toContain('tests-runtime.json');
  const config = await resolveConfig(join(ROOT, SINGLE));
  const formatted = await Promise.all(
    files.map((name) => {
      const path = join(root, FOLDER, name);
      return check(readFileSync(path, 'utf8'), { ...config, filepath: path });
    }),
  );
  expect(formatted.every(Boolean), 'every file is already prettier-formatted').toBe(true);
});

it('split, run as a command in the repository, refuses now the folder exists and changes nothing', () => {
  const before = readdirSync(join(ROOT, FOLDER));
  const script = join(ROOT, 'scripts/named-suites.ts');
  const run = spawnSync(process.execPath, [script, 'split'], { cwd: ROOT, encoding: 'utf8' });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/already exists/u);
  expect(readdirSync(join(ROOT, FOLDER))).toStrictEqual(before);
  expect(existsSync(join(ROOT, SINGLE))).toBe(false);
}, 60_000);

it('split refuses when the folder already exists, and leaves it alone', async () => {
  const root = folder({ 'tests-api.json': { invariant: [API] } });
  writeFileSync(join(root, SINGLE), JSON.stringify({ comment: [], invariant: [RUNTIME] }));
  await expect(splitToFolder(root)).rejects.toThrow(/already exists/u);
  expect(readdirSync(join(root, FOLDER))).toStrictEqual(['tests-api.json']);
});

it('split fails and leaves no folder when the join would not equal the single file', async () => {
  const root = tempRoot(JSON.stringify({ comment: [], invariant: [API, API], conformance: [] }));
  await expect(splitToFolder(root)).rejects.toThrow(/named twice|does not read back/u);
  expect(existsSync(join(root, FOLDER))).toBe(false);
  expect(existsSync(join(root, SINGLE))).toBe(true);
});

it('splitNamedSuites files each suite under its own area and keeps the comment as history', () => {
  const split = splitNamedSuites({
    comment: ['why'],
    invariant: [RUNTIME, API],
    conformance: ['tests/api/c.test.ts'],
  });
  expect(split).toStrictEqual({
    history: { comment: ['why'] },
    areas: {
      'tests-api': { invariant: [API], conformance: ['tests/api/c.test.ts'] },
      'tests-runtime': { invariant: [RUNTIME], conformance: [] },
    },
  });
});
it('without the folder, reads the single file exactly as before, in its own order', () => {
  expect(readNamedSuites(tempRoot(realText))).toStrictEqual(real);
});

it('joins the comment as history then each area in file order, and sorts the suites', () => {
  const root = folder({
    'tests-runtime.json': {
      comment: ['runtime'],
      invariant: [RUNTIME, 'tests/runtime/a.test.ts'],
    },
    '_history.json': { comment: ['first', 'second'] },
    'tests-api.json': {
      comment: ['api'],
      invariant: [API],
      conformance: ['tests/api/z.test.ts'],
    },
  });
  expect(readNamedSuites(root)).toStrictEqual({
    comment: ['first', 'second', 'api', 'runtime'],
    invariant: [API, 'tests/runtime/a.test.ts', RUNTIME],
    conformance: ['tests/api/z.test.ts'],
  });
});

it('refuses a file that is not valid JSON', () => {
  refused({ 'tests-api.json': '{ "invariant": [' }, 'tests-api.json', /not valid JSON/u);
});

it('refuses an unknown key, in an area file or in the history', () => {
  refused({ 'tests-api.json': { invariants: [API] } }, 'tests-api.json', /unknown key/u);
  refused(
    {
      '_history.json': { comment: [], invariant: [API] },
      'tests-api.json': { conformance: [API] },
    },
    '_history.json',
    /unknown key "invariant"/u,
  );
});

it('refuses a list that is not an array, or an entry that is not a string', () => {
  refused({ 'tests-api.json': { invariant: API } }, 'tests-api.json', /array of strings/u);
  refused({ 'tests-api.json': { invariant: [API, 3] } }, 'tests-api.json', /array of strings/u);
  refused({ '_history.json': { comment: [null] } }, '_history.json', /array of strings/u);
});

it('refuses a suite filed under an area that is not its own', () => {
  refused({ 'tests-api.json': { invariant: [RUNTIME] } }, 'tests-api.json', /tests-runtime/u);
});

it('refuses a path named twice, within a list, across kinds or across files', () => {
  refused({ 'tests-api.json': { invariant: [API, API] } }, 'tests-api.json', /named twice/u);
  refused(
    { 'tests-api.json': { invariant: [API], conformance: [API] } },
    'tests-api.json',
    /named twice/u,
  );
  refused(
    { 'tests-api.json': { invariant: [API] }, 'tests-runtime.json': { conformance: [API] } },
    'tests-runtime.json',
    /named twice/u,
  );
});

it('refuses an area file that names no suite', () => {
  refused(
    { 'tests-api.json': { comment: ['only words'], invariant: [] } },
    'tests-api.json',
    /names no suite/u,
  );
});

it('refuses a file that is not .json', () => {
  refused(
    { 'tests-api.json': { invariant: [API] }, 'notes.md': 'x' },
    'notes.md',
    /not a \.json file/u,
  );
});
