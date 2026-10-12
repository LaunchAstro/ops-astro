// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1: the local runner's home lock (`apps/local-agent/home-lock.ts`). A
// holder whose process exists under another user is alive, a lock that names
// no runner is refused with its path, and a runner that dies while making its
// lock leaves no empty lock behind to refuse every later runner.

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync as plainWrite } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { holdHome } from '../../apps/local-agent/home-lock.ts';

/** When set, the next write of a file under the lock's name dies after making it empty. */
const crash = vi.hoisted(() => ({ next: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((...args: Parameters<typeof actual.writeFileSync>) => {
    if (crash.next && String(args[0]).includes('runner.lock')) {
      crash.next = false;
      actual.writeFileSync(args[0], '', { flag: 'wx' });
      throw new Error('the runner died while writing its lock');
    }
    actual.writeFileSync(...args);
  }) as typeof actual.writeFileSync;
  return { ...actual, writeFileSync };
});

const made: string[] = [];
const home = (): string => {
  const at = mkdtempSync(join(tmpdir(), 'runner-home-'));
  made.push(at);
  return at;
};

afterEach(() => {
  crash.next = false;
  for (const at of made.splice(0)) rmSync(at, { recursive: true, force: true });
});

it("a home held by another user's live runner is not taken over", () => {
  const at = home();
  // Process 1 exists and this user may not signal it: `kill` answers EPERM.
  plainWrite(join(at, 'runner.lock'), '1 0b8c0a8e-6d4e-4c1b-9a51-1f0c5e7b2d33');
  expect(() => holdHome(at)).toThrow(/LOCAL_HOME_IN_USE/u);
});

it('a lock that names no runner is refused with its path', () => {
  const at = home();
  const lock = join(at, 'runner.lock');
  plainWrite(lock, '');
  expect(() => holdHome(at)).toThrow(lock);
});

it('a runner that dies while making its lock leaves the home free for the next', () => {
  const at = home();
  crash.next = true;
  expect(() => holdHome(at)).toThrow('the runner died while writing its lock');
  expect(existsSync(join(at, 'runner.lock')), 'an empty lock was left on the path').toBe(false);
  const release = holdHome(at);
  release();
  expect(readdirSync(at)).toStrictEqual([]);
});
