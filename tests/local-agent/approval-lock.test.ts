// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859) review 3: approvals.json is read, changed and written under a
// lock in the home, so two ticks on one home never drop or bring back an
// entry, and a held lock is waited on, never written through. Local only.
// Made-up data; no database.

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { writeApproval } from '../../apps/local-agent/approval.ts';
import { readApprovals } from '../../apps/local-agent/settings.ts';
import { makeWorld, type World } from './world.ts';

const run = promisify(execFile);
const APPROVAL = resolve(import.meta.dirname, '../../apps/local-agent/approval.ts');

let world: World | undefined;
afterEach(() => {
  world?.remove();
  world = undefined;
});

/** One tick process: from `startAt`, add `count` models of its own, one write each. */
const writer = (home: string, name: string, count: number, startAt: number): string => `
  const { writeApproval } = await import(${JSON.stringify(APPROVAL)});
  while (Date.now() < ${String(startAt)});
  for (let i = 0; i < ${String(count)}; i += 1) {
    await writeApproval(${JSON.stringify(home)}, { kind: 'model', model: '${name}-' + i });
  }`;

it('two tick processes adding different needs on one home both keep every one', async () => {
  world = makeWorld();
  const home = world.agentHome;
  const startAt = Date.now() + 1_500;
  const names = ['tick-a', 'tick-b', 'tick-c', 'tick-d'];
  await Promise.all(
    names.map(
      async (name) =>
        await run(process.execPath, [
          '--input-type=module',
          '-e',
          writer(home, name, 100, startAt),
        ]),
    ),
  );
  const models = readApprovals(home).models;
  expect(models).toHaveLength(400);
  expect(new Set(models).size).toBe(400);
}, 30_000);

it('a held lock is waited on and never written through', async () => {
  world = makeWorld();
  const home = world.agentHome;
  const lock = join(home, 'approvals.json.lock');
  const opus = async (): Promise<void> => {
    await writeApproval(home, { kind: 'model', model: 'opus' });
  };
  world.write('approvals.json.lock', 'another tick');
  await expect(opus()).rejects.toThrow(/APPROVALS_LOCKED/u);
  expect(existsSync(join(home, 'approvals.json'))).toBe(false);
  expect(existsSync(lock)).toBe(true);

  // Let go while the writer waits: it then writes, and lets go itself.
  const writing = opus();
  expect(existsSync(join(home, 'approvals.json'))).toBe(false);
  setTimeout(() => {
    rmSync(lock);
  }, 200);
  await writing;
  expect(readApprovals(home).models).toEqual(['opus']);
  expect(existsSync(lock)).toBe(false);
}, 30_000);
