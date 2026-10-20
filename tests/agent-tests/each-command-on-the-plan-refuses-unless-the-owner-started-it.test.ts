// SPDX-License-Identifier: AGPL-3.0-only
//
// #1626 R12: each set's command on the owner's plan (`--plan`) refuses unless
// the owner started it. The owner's start is one line, written by hand beside
// the plan's token file, naming the set and today's date. Without it, with one
// for another set or another day, one anyone else can read or that is a link,
// one with anything more in it, or in CI, the real process exits 2, writes no
// results file, starts no custody and leaves the line where it was. A start
// line that fits is used once: it is gone when the run begins.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'agent-tests-plan-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const localDate = (offsetDays = 0): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA');

let homes = 0;
/** A home with the plan's folder, owner-only, and no token file in it. */
function home(): { readonly home: string; readonly start: string; readonly out: string } {
  homes += 1;
  const at = join(dir, `home-${String(homes)}`);
  mkdirSync(join(at, '.ops-astro'), { recursive: true, mode: 0o700 });
  return {
    home: at,
    start: join(at, '.ops-astro', 'agent-tests-start.json'),
    out: join(at, 'results.json'),
  };
}

const run = (at: string, set: string, out: string, ci: Record<string, string> = {}) => {
  const { CI: _ci, GITHUB_ACTIONS: _actions, ...env } = process.env;
  return spawnSync(process.execPath, ['apps/agent-tests/main.ts', set, '--plan', '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...env, HOME: at, ...ci },
  });
};
/** A start line for `set`, as the owner writes it, with any change a case makes. */
const line = (set: string, change: Record<string, unknown> = {}) =>
  `${JSON.stringify({ set, date: localDate(), ...change })}\n`;

type Plant = (start: string, set: string, other: string) => void;

const REFUSED: readonly [string, Plant, Record<string, string>][] = [
  ['no start line', () => {}, {}],
  [
    'a start line for the other set',
    (start, _set, other) => writeFileSync(start, line(other), { mode: 0o600 }),
    {},
  ],
  [
    'a start line from yesterday',
    (start, set) => writeFileSync(start, line(set, { date: localDate(-1) }), { mode: 0o600 }),
    {},
  ],
  [
    'a start line with more in it',
    (start, set) => writeFileSync(start, line(set, { by: 'agent' }), { mode: 0o600 }),
    {},
  ],
  [
    'a start line anyone else can read',
    (start, set) => writeFileSync(start, line(set), { mode: 0o644 }),
    {},
  ],
  [
    'a start line that is a link',
    (start, set) => {
      writeFileSync(`${start}.real`, line(set), { mode: 0o600 });
      symlinkSync(`${start}.real`, start);
    },
    {},
  ],
  [
    'a fitting start line, in CI',
    (start, set) => writeFileSync(start, line(set), { mode: 0o600 }),
    { CI: 'true' },
  ],
  [
    'a fitting start line, in GitHub Actions',
    (start, set) => writeFileSync(start, line(set), { mode: 0o600 }),
    { GITHUB_ACTIONS: 'true' },
  ],
];

const contents = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined;

describe.each([
  ['luna', 'sol'],
  ['sol', 'luna'],
])('the %s command on the plan', (set, other) => {
  it.each(REFUSED)(
    'refuses with %s, writing nothing and starting no custody',
    (_name, plant, ci) => {
      const at = home();
      plant(at.start, set, other);
      const before = contents(at.start);
      const done = run(at.home, set, at.out, ci);
      expect(done.status, done.stderr).toBe(2);
      expect(done.stderr).toMatch(/^agent-tests: /u);
      expect(done.stderr).not.toMatch(/custody/u);
      expect(done.stdout).toBe('');
      expect(existsSync(at.out)).toBe(false);
      expect(contents(at.start)).toBe(before);
    },
  );

  it('uses a fitting start line once: it is gone when the run begins', () => {
    const at = home();
    writeFileSync(at.start, line(set), { mode: 0o600 });
    // No token file is there, so custody refuses every turn and nothing is sent.
    const done = run(at.home, set, at.out);
    expect(existsSync(at.start)).toBe(false);
    expect(done.stderr).not.toMatch(/owner/u);
    expect(done.status, done.stderr).toBe(1);
    const results = JSON.parse(readFileSync(at.out, 'utf8')) as {
      provider: string;
      cases: { endCode: string; model: string | null }[];
    };
    expect(results.provider).toBe('chatgpt_plan');
    expect(results.cases.length).toBeGreaterThan(0);
    for (const one of results.cases) {
      expect(one).toMatchObject({ endCode: 'CUSTODY_NOT_ADMITTED', model: null });
    }
    const again = run(at.home, set, join(at.home, 'again.json'));
    expect(again.status).toBe(2);
    expect(existsSync(join(at.home, 'again.json'))).toBe(false);
  });
});
