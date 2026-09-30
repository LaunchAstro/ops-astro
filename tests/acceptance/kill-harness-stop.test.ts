// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d2's kill harness, check 1 (the stopped process reads `T`), under load
// (T4e, REV185C). "Stopped within 2 s" is a `T` read before one monotonic
// two-second deadline that each `ps` reading spends too; a reading past it,
// or with no state, leaves the stop unproven. A process that never reads
// stopped fails, naming each reading.

import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { awaitStopped, processState } from './kill-harness.ts';

describe('the kill harness waits for the stop, not for ps', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  afterAll(() => {
    child.kill('SIGKILL');
  });

  it('reads a real SIGSTOP as stopped', async () => {
    process.kill(child.pid as number, 'SIGSTOP');
    const seen = await awaitStopped(child.pid as number, 2_000);
    expect(seen.stopped, seen.probes.join(', ')).toBe(true);
    expect(processState(child.pid as number)).toMatch(/^T/u);
  });

  it('a stop read with no state is unproven at once', async () => {
    const blank = await awaitStopped(1, 2_000, () => '');
    expect(blank.probes).toEqual([expect.stringMatching(/^- in /u), 'unproven: ps gave no state']);
    expect(blank.stopped).toBe(false);
  });

  it('a process that never reads stopped fails once the wait is spent, naming each reading', async () => {
    const started = Date.now();
    const seen = await awaitStopped(1, 300, () => 'S');
    expect(seen.stopped).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(seen.probes.length).toBeGreaterThan(1);
    expect(seen.probes.slice(0, -1).every((one) => one.startsWith('S in '))).toBe(true);
  });
});
