// SPDX-License-Identifier: AGPL-3.0-only
//
// A Codex call runs in a process group of its own, so its deadline can stop
// a wrapper's descendants. That group sits outside the terminal's Ctrl-C and
// outside a stop sent to the runner's process alone, so a runner stopped
// mid-call with SIGTERM or SIGINT stops the group itself before it goes:
// neither the wrapper nor what it started outlives the runner.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const left: number[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const pid of left.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pidIn = (file: string): number | null =>
  existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;

const CODEX = resolve(import.meta.dirname, '../../apps/local-agent/codex.ts');

it.each(['SIGTERM', 'SIGINT'] as const)(
  'a runner stopped with %s mid-call leaves nothing its wrapper started',
  async (signal) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-stopped-'));
    roots.push(root);
    const [wrapperFile, descendantFile] = [join(root, 'wrapper.pid'), join(root, 'child.pid')];
    const wrapper = join(root, 'codex-wrapper.sh');
    // The wrapper and the process it starts each write their pid, then wait.
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > '${wrapperFile}'\n(sh -c 'echo $$ > "${descendantFile}"; sleep 30') &\nwait\n`,
    );
    chmodSync(wrapper, 0o700);
    const home = join(root, 'runner');
    const settings = {
      key: 'k',
      home,
      codexHome: join(home, 'codex-home'),
      codexBin: wrapper,
      capTokens: 1_000_000,
      capConfigured: false,
      childEnv: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, LANG: 'C' },
      timeoutMs: 60_000,
    };
    const script = `import { runCodex } from ${JSON.stringify(CODEX)};
await runCodex(${JSON.stringify(settings)}, 'gpt-5', 'Hello');`;
    const runner = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'ignore',
    });
    await expect
      .poll(() => pidIn(wrapperFile) !== null && pidIn(descendantFile) !== null, {
        timeout: 5_000,
      })
      .toBe(true);
    const pids = [pidIn(wrapperFile) ?? 0, pidIn(descendantFile) ?? 0];
    left.push(...pids);
    const exited = once(runner, 'exit');
    runner.kill(signal);
    await exited;
    await expect.poll(() => pids.filter((pid) => alive(pid)), { timeout: 3_000 }).toStrictEqual([]);
  },
  15_000,
);
