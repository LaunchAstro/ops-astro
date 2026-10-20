// SPDX-License-Identifier: AGPL-3.0-only
//
// #1626 R12, the independent review's proof, its body unchanged: two runs of
// one set read the same start line and wait; the first is admitted and takes
// the line away; the owner then writes a new line for the same set and day,
// word for word the same; the second run, still holding the used line, is
// refused and leaves the new line where it is.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = resolvePath(import.meta.dirname, '../..');

// Lint-only moves out of the review's test body, behaviour unchanged.
const line = (set: string) => JSON.stringify({ set, date: new Date().toLocaleDateString('en-CA') });
const waitReady = async (file: string) => {
  const until = Date.now() + 10000;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error(`worker did not read approval: ${file}`);
    // oxlint-disable-next-line no-await-in-loop -- polls for the worker's barrier file
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

// oxlint-disable-next-line max-lines-per-function -- the review's proof, kept whole
it('a run that read a start line another run then used is refused by a newer line with the same words, and leaves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sol-2205-start-race-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.ops-astro'), { recursive: true, mode: 0o700 });
  const start = join(home, '.ops-astro', 'agent-tests-start.json');
  writeFileSync(start, line('sol'), { mode: 0o600 });
  const children: ChildProcess[] = [];
  const worker = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [home, ready, release] = process.argv.slice(1);
    const original = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      const answer = original.call(this, file, ...args);
      if (typeof file === 'number' && args[0] === 'utf8' && String(answer).includes('"set":"sol"')) {
        fs.writeFileSync(ready, 'read');
        const until = Date.now() + 10000;
        while (!fs.existsSync(release)) {
          if (Date.now() > until) throw new Error('barrier timed out');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return answer;
    };
    syncBuiltinESMExports();
    const { ownerStarted } = await import('./apps/agent-tests/plan.ts');
    const why = ownerStarted(home, 'sol');
    console.log(JSON.stringify({ admitted: why === undefined, why }));
  `;
  const begin = (id: string) => {
    const ready = join(dir, `${id}.ready`);
    const release = join(dir, `${id}.release`);
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', worker, home, ready, release],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (part) => {
      stdout += String(part);
    });
    child.stderr.on('data', (part) => {
      stderr += String(part);
    });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    return { ready, release, done };
  };
  try {
    const first = begin('first');
    const stale = begin('stale');
    await Promise.all([waitReady(first.ready), waitReady(stale.ready)]);
    writeFileSync(first.release, 'go');
    const used = await first.done;
    expect(used.code, used.stderr).toBe(0);
    expect(JSON.parse(used.stdout)).toMatchObject({ admitted: true });
    expect(existsSync(start)).toBe(false);

    // The first approval is gone. A fresh owner start for Sol has the same permitted bytes.
    const next = line('sol');
    writeFileSync(start, next, { mode: 0o600 });
    expect(readFileSync(start, 'utf8')).toBe(next);
    writeFileSync(stale.release, 'go');
    const again = await stale.done;
    expect(again.code, again.stderr).toBe(0);
    expect(
      JSON.parse(again.stdout),
      'the stale run claimed a different, newer approval because its bytes match the used approval',
    ).toMatchObject({ admitted: false });
    expect(readFileSync(start, 'utf8')).toBe(next);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
