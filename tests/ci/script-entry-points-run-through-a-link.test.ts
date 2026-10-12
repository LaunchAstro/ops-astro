// SPDX-License-Identifier: AGPL-3.0-only
//
// The command-line scripts find their entry point by real path, so run from a
// checkout reached through a link, or whose path holds a space, each still
// does its work: the same output as run directly, never a silent exit 0.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'entry-through-link-'));
const LINKED = join(dir, 'ops astro');
symlinkSync(ROOT, LINKED);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The script at `root`, as a shell runs it: its status and what it said. */
function ran(root: string, script: string, args: string[], env: Record<string, string> = {}) {
  const run = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { status: run.status, said: `${run.stdout}${run.stderr}`.length > 0 };
}

const SCRIPTS: readonly (readonly [string, string[], Record<string, string>])[] = [
  ['token-diff.mjs', [], {}],
  ['type-census.mjs', [], {}],
  ['command-parity.mjs', ['--json'], {}],
  ['candidate-snapshot.mjs', [], {}],
  ['sent-back-hold.mjs', [], { GITHUB_EVENT_NAME: 'push' }],
];

describe('script entry points', () => {
  it.each(SCRIPTS)(
    '%s runs through a linked, spaced path as it runs directly',
    (script, args, env) => {
      const direct = ran(ROOT, script, args, env);
      expect(direct.said, 'control: run directly, it says something').toBe(true);
      expect(ran(LINKED, script, args, env), 'run through a link, it does nothing').toEqual(direct);
    },
    120_000,
  );
});
