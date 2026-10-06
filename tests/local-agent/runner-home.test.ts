// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1: one runner holds a home at a time. A lock left by a runner that has
// gone is taken over by one runner only, however the takeovers interleave.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRunner, type Runner } from '../../apps/local-agent/runner.ts';
import { readSettings, type RunnerSettings } from '../../apps/local-agent/settings.ts';
import { runnerWorld } from './runner-world.ts';
import { makeWorld, type World } from './world.ts';

/** Run once just after the next read of a runner lock, before its reader acts on what it read. */
const hooks = vi.hoisted(() => ({ afterLockRead: undefined as (() => void) | undefined }));

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
  return { ...actual, readFileSync };
});

const { opened, own } = runnerWorld();

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
  });
});
