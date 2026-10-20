// SPDX-License-Identifier: AGPL-3.0-only
// The second-model check's proof, kept as it was written: the M5 trace export
// refuses a Langfuse credential file others can read before it starts, and
// the custody process it forks for that credential opens no inspector on
// SIGUSR1. Its polls wait on purpose.
/* oxlint-disable no-await-in-loop, no-shadow, no-promise-executor-return, require-unicode-regexp */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
async function launch(mode: number, check: (pid: number, out: () => string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'trace-security-proof-'));
  const credentials = join(dir, 'credentials.json');
  writeFileSync(
    credentials,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'proof',
        destination: 'trace_target',
        header: 'authorization',
        scheme: 'basic',
        value: 'public:synthetic-proof-only',
      },
    ]),
    { mode },
  );
  const key = join(dir, 'key');
  writeFileSync(key, 'ab'.repeat(32), { mode: 0o600 });
  const settings = join(dir, 'settings');
  writeFileSync(
    settings,
    `TRACE_EXPORT=on\nTRACE_EXPORT_ORIGIN=http://127.0.0.1:3400\nTRACE_EXPORT_CREDENTIALS_FILE=${credentials}\nTRACE_EXPORT_KEY_FILE=${key}\nDATABASE_TRACE_URL=postgres://proof:synthetic@127.0.0.1:1/proof\nTRACE_EXPORT_BUSINESSES=4f1c2a9e-6b1d-4c3a-9e2f-0a1b2c3d4e5f`,
    { mode: 0o600 },
  );
  let out = '';
  const child = spawn(process.execPath, ['--disable-sigusr1', 'apps/trace-export/main.ts'], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'], TRACE_EXPORT_SETTINGS_FILE: settings },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => (out += chunk.toString()));
  child.stderr.on('data', (chunk) => (out += chunk.toString()));
  try {
    await check(child.pid!, () => out);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
async function started(out: () => string) {
  for (let n = 0; n < 200; n++) {
    if (out().includes('trace export: on for')) return;
    await sleep(25);
  }
  throw new Error('exporter did not start: ' + out());
}
it('a Langfuse credential file others can read is refused before the export starts', async () => {
  await launch(0o644, async (_pid, out) => {
    for (let n = 0; n < 200; n++) {
      if (out().length > 0) break;
      await sleep(25);
    }
    expect(out()).not.toContain('trace export: on for');
    expect(out()).toMatch(/credential.*(?:owner|readable|permission)/i);
  });
}, 15000);
it('the custody child holding the trace credential opens no inspector on SIGUSR1', async () => {
  await launch(0o600, async (pid, out) => {
    await started(out);
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split(
      '\n',
    );
    const row = rows.find((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m && Number(m[2]) === pid && (m[3] ?? '').includes('custody-main.ts');
    });
    expect(row).toBeDefined();
    const custodyPid = Number(/^\s*(\d+)/.exec(row!)![1]);
    process.kill(custodyPid, 'SIGUSR1');
    await sleep(500);
    const probe = spawnSync(
      'lsof',
      ['-P', '-a', '-p', String(custodyPid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf8' },
    );
    expect(probe.error).toBeUndefined();
    expect([0, 1]).toContain(probe.status);
    const listeners = probe.stdout;
    expect(listeners).toBe('');
  });
}, 15000);
