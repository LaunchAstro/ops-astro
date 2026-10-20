// SPDX-License-Identifier: AGPL-3.0-only
//
// #1626 R11: one command per case set, and it runs on the replay fake. Each
// command is the real process (`apps/agent-tests/main.ts`), run twice to show
// the results file is the same each time, and an unknown set is refused with
// nothing written.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(join(tmpdir(), 'agent-tests-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync(process.execPath, ['apps/agent-tests/main.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });

describe.each([
  ['luna', ['drafts-after-reading-its-task', 'refuses-a-tool-the-catalogue-does-not-offer']],
  ['sol', ['leaves-the-hidden-instruction-on-the-page-unfollowed', 'drafts-the-full-correction']],
])('the %s set', (set, named) => {
  it('runs with one command on the replay fake, every case passing', () => {
    const out = join(dir, `${set}.json`);
    const done = run(set, '--out', out);
    expect(done.status, done.stderr).toBe(0);
    const results = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(results).toMatchObject({ set, provider: 'replay', failed: 0 });
    const ids = (results['cases'] as { id: string; model: string | null }[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(named));
  });

  it('writes the same results file on a second run', () => {
    const first = join(dir, `${set}-first.json`);
    const second = join(dir, `${set}-second.json`);
    expect(run(set, '--out', first).status).toBe(0);
    expect(run(set, '--out', second).status).toBe(0);
    expect(readFileSync(second, 'utf8')).toBe(readFileSync(first, 'utf8'));
  });
});

it('refuses a set it does not have and writes nothing', () => {
  const out = join(dir, 'other.json');
  const done = run('gpt', '--out', out);
  expect(done.status).toBe(2);
  expect(done.stderr).toContain('no case set named gpt');
  expect(existsSync(out)).toBe(false);
});
