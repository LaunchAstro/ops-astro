// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1: one runner holds a home at a time. A lock left by a runner that has
// gone is taken over by one runner only, however the takeovers interleave,
// and a runner lets go of its own hold only.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync as readText, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings, type RunnerSettings } from '../../apps/local-agent/settings.ts';
import { runnerWorld } from './runner-world.ts';
import { makeWorld, type World } from './world.ts';

/**
 * Run once just after the next read of a runner lock, before its reader acts on
 * what it read, or just after the next move of a runner lock off its path.
 */
const hooks = vi.hoisted(() => ({
  afterLockRead: undefined as (() => void) | undefined,
  afterLockMove: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const text = actual.readFileSync(...args);
    if (String(args[0]).endsWith('runner.lock')) {
      const hook = hooks.afterLockRead;
      hooks.afterLockRead = undefined;
      hook?.();
    }
    return text;
  }) as typeof actual.readFileSync;
  const renameSync = ((...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args);
    if (String(args[0]).endsWith('runner.lock')) {
      const hook = hooks.afterLockMove;
      hooks.afterLockMove = undefined;
      hook?.();
    }
  }) as typeof actual.renameSync;
  return { ...actual, readFileSync, renameSync };
});

const { opened, own, start } = runnerWorld();

function settingsOf(w: World): RunnerSettings {
  const read = readSettings(w.env, w.userHome);
  if (!read.ok) throw new Error(read.code);
  return read.settings;
}

/** A laptop whose home holds the lock of a runner that has gone. */
function deadLock(): World {
  const w = makeWorld();
  own(w);
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  writeFileSync(`${w.agentHome}/runner.lock`, String(pid));
  return w;
}

/** The runners that started, kept for closing, and why the others did not. */
async function outcomes(starts: readonly Promise<Runner>[]): Promise<string[]> {
  const settled = await Promise.allSettled(starts);
  return settled.map((result) => {
    if (result.status === 'rejected') return String(result.reason);
    opened.push(result.value);
    return 'started';
  });
}

/** The home is still held: its lock names this process, and a third start is refused. */
async function stillHeld(settings: RunnerSettings): Promise<void> {
  expect(readText(join(settings.home, 'runner.lock'), 'utf8')).toMatch(
    new RegExp(`^${String(process.pid)} `, 'u'),
  );
  expect(await outcomes([createRunner(settings, () => null)])).toEqual([
    expect.stringContaining('LOCAL_HOME_IN_USE'),
  ]);
}

/**
 * Three runners on a gone runner's home: the first reads the gone runner and
 * pauses, the second takes the home over meanwhile, then the first goes on and
 * the third starts the moment the first moves the lock (or after it, if it never does).
 */
function lateTakeover(settings: RunnerSettings): Promise<Runner>[] {
  let second: Promise<Runner> | undefined;
  let third: Promise<Runner> | undefined;
  const startThird = (): void => {
    third ??= createRunner(settings, () => null);
  };
  hooks.afterLockRead = () => {
    second = createRunner(settings, () => null);
    hooks.afterLockMove = startThird;
  };
  const first = createRunner(settings, () => null);
  startThird();
  hooks.afterLockMove = undefined;
  if (second === undefined || third === undefined) throw new Error('a runner never started');
  return [first, second, third];
}

describe('a home left by a runner that has gone', () => {
  it('is taken over by one of two runners started on it at once', async () => {
    const settings = settingsOf(deadLock());
    const started = await outcomes([
      createRunner(settings, () => null),
      createRunner(settings, () => null),
    ]);
    expect(started.filter((outcome) => outcome === 'started')).toHaveLength(1);
    expect(started.find((outcome) => outcome !== 'started')).toContain('LOCAL_HOME_IN_USE');
  });

  it('is taken over by one runner when both read the gone runner before either takes it', async () => {
    const settings = settingsOf(deadLock());
    let second: Promise<Runner> | undefined;
    hooks.afterLockRead = () => {
      second = createRunner(settings, () => null);
    };
    const first = createRunner(settings, () => null);
    if (second === undefined) throw new Error('the second runner never read the lock');
    const started = await outcomes([first, second]);
    expect(started.filter((outcome) => outcome === 'started')).toHaveLength(1);
    expect(started.find((outcome) => outcome !== 'started')).toContain('LOCAL_HOME_IN_USE');
    await stillHeld(settings);
  });

  it('is held by one runner when a third starts while a late takeover is under way', async () => {
    const settings = settingsOf(deadLock());
    const started = await outcomes(lateTakeover(settings));
    expect(started.filter((outcome) => outcome === 'started')).toHaveLength(1);
    for (const outcome of started.filter((one) => one !== 'started')) {
      expect(outcome).toContain('LOCAL_HOME_IN_USE');
    }
    await stillHeld(settings);
    // The lock is the started runner's own: closing it lets the home go.
    const holder = opened.pop();
    await holder?.close();
    expect(existsSync(join(settings.home, 'runner.lock'))).toBe(false);
  });
});

describe('a home whose takeover was left unfinished', () => {
  it('refuses, names the takeover lock to remove, and writes nothing', async () => {
    const w = deadLock();
    const settings = settingsOf(w);
    const takeover = join(settings.home, 'runner.lock.takeover');
    writeFileSync(takeover, '1 left');
    const before = readdirSync(settings.home).toSorted();
    const lockBefore = readText(join(settings.home, 'runner.lock'), 'utf8');
    const [outcome] = await outcomes([createRunner(settings, () => null)]);
    expect(outcome).toContain('LOCAL_HOME_IN_USE');
    expect(outcome).toContain(takeover);
    expect(readdirSync(settings.home).toSorted()).toEqual(before);
    expect(readText(join(settings.home, 'runner.lock'), 'utf8')).toBe(lockBefore);
    expect(readText(takeover, 'utf8')).toBe('1 left');
  });
});

describe('a runner closed twice', () => {
  it('never lets go of the home a runner after it holds', async () => {
    const { w, r: first } = await start();
    await first.close();
    opened.length = 0;
    opened.push(await createRunner(settingsOf(w), () => null));
    await first.close();
    const [third] = await outcomes([createRunner(settingsOf(w), () => null)]);
    expect(third).toContain('LOCAL_HOME_IN_USE');
  });
});
