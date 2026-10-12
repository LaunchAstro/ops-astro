// SPDX-License-Identifier: AGPL-3.0-only
//
// Without a database, vitest.config.ts leaves out the proof files that open
// their worlds with no skip, so the `local checks` job does not throw on them.
// Leaving a file out there is safe only because `database conformance` runs it:
// a file left out that no database suite names is run by no required context,
// and a regression in it merges green. Each file the config leaves out only
// without a database, or each file its pattern matches, must exist and be named
// in the manifest.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

// The config reads DATABASE_URL once, when it loads, so each setting is read
// in a process of its own.
const SCRIPT = `
import { globSync } from 'node:fs';
import { readNamedSuites } from './scripts/named-suites.ts';
const exclude = async (database) => {
  process.env.DATABASE_URL = database;
  return (await import('./vitest.config.ts?' + (database === '' ? 'free' : 'bound'))).default.test.exclude;
};
const free = await exclude('');
const bound = await exclude('postgres://unused@127.0.0.1:1/unused');
const manifest = readNamedSuites('.');
const named = new Set([...manifest.invariant, ...manifest.conformance]);
const left = free.filter((pattern) => !bound.includes(pattern));
console.log(JSON.stringify({
  left: left.length,
  matchNothing: left.filter((pattern) => globSync(pattern).length === 0),
  unnamed: left.flatMap((pattern) => globSync(pattern)).filter((path) => !named.has(path)),
}));
`;

describe('files left out of database-free runs', () => {
  it('each exists and is named in a database suite', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] },
    });
    expect(run.status, run.stderr).toBe(0);
    const found = JSON.parse(run.stdout) as {
      left: number;
      matchNothing: string[];
      unnamed: string[];
    };
    expect(found.left).toBeGreaterThan(0);
    expect({ matchNothing: found.matchNothing, unnamed: found.unnamed }).toStrictEqual({
      matchNothing: [],
      unnamed: [],
    });
  });
});
