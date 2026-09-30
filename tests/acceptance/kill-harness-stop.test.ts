// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d2's kill harness, check 1 (the stopped process reads `T`), under load
// (T4e, REV185B2 item 6). The two seconds bound how long the process may take
// to stop, not how long one `ps` takes to start: on a loaded host a single
// start of the setuid `ps` can take longer than the stop, and a stopped
// process read late is still stopped. A process that never reads stopped
// still fails, naming each reading.

import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { awaitStopped, processState } from './kill-harness.ts';

/** A probe whose first `ps` start takes `ms`, as one can on a loaded host. */
function slowFirst(ms: number, readings: readonly string[]): (pid: number) => string {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls === 1) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        // Blocked, as `execFileSync('ps')` blocks while the host is busy.
      }
    }
    return readings[Math.min(calls, readings.length) - 1] ?? '';
  };
}

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

  it('a stop read after one slow ps start is still a stop', async () => {
    const seen = await awaitStopped(1, 2_000, slowFirst(2_100, ['S', 'T']));
    expect(seen.stopped, seen.probes.join(', ')).toBe(true);
    expect(seen.probes).toHaveLength(2);
  });

  it('a process that never reads stopped fails once the wait is spent, naming each reading', async () => {
    const started = Date.now();
    const seen = await awaitStopped(1, 300, () => 'S');
    expect(seen.stopped).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(seen.probes.length).toBeGreaterThan(1);
    expect(seen.probes.every((one) => one.startsWith('S in '))).toBe(true);
  });
});
