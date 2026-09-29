// SPDX-License-Identifier: AGPL-3.0-only
//
// The journey command stops only what it started (the 29 September pid-reuse
// incident: a pid recorded forty minutes earlier, long exited, belonged to
// another process by the time the command stopped it). It signals process
// groups it created and nothing else, and only while the group still has a
// member running one of the journey's own commands. A plain pid in the file
// is never signalled, whoever holds it now. Every process here is this test's
// own.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stopStarted } from '../../scripts/local/journey-stack.ts';

const scratch = mkdtempSync(join(tmpdir(), 'journey-stop-'));
const started: ChildProcess[] = [];

/** A process of this test's own that waits to be stopped, named like a journey command or not. */
function waiting(name: string, detached: boolean): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', name], {
    detached,
    stdio: 'ignore',
  });
  started.push(child);
  return child;
}

const alive = (pid: number | undefined): boolean => {
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
};

const settle = async (): Promise<void> => {
  await new Promise((done) => {
    setTimeout(done, 300);
  });
};

describe('the journey stops only the process groups it created', () => {
  afterAll(() => {
    for (const child of started) child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  });

  it('stops its own group, and never a plain pid in the file', async () => {
    const group = waiting('tests/journey/run.ts', true);
    const plain = waiting('apps/cli/main.ts', false);
    const pidfile = join(scratch, 'one.pids');
    writeFileSync(
      pidfile,
      `-${String(group.pid)} tests/journey/run.ts (process group)\n${String(plain.pid)} cli task.read\n`,
    );
    const said: string[] = [];
    stopStarted(pidfile, (line: string) => said.push(line));
    await settle();
    expect(alive(group.pid)).toBe(false);
    expect(alive(plain.pid)).toBe(true);
    expect(said.join('\n')).not.toContain(String(plain.pid));
  });

  it('leaves a group alone when none of its members runs a journey command', async () => {
    const stranger = waiting('someone-else.mjs', true);
    const pidfile = join(scratch, 'two.pids');
    writeFileSync(pidfile, `-${String(stranger.pid)} vite (process group)\n`);
    const said: string[] = [];
    stopStarted(pidfile, (line: string) => said.push(line));
    await settle();
    expect(alive(stranger.pid)).toBe(true);
    expect(said.join('\n')).toContain('not stopped');
  });
});
