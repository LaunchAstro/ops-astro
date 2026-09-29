// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1, spike RN-03: the browser harness has no default address, so a proof
// cannot reach the live demo's 5190 and 8790 by forgetting `WEB_URL`, and its
// port guard refuses a second run on a port a live run holds.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = '65431';

function load(env: Readonly<Record<string, string>>): { code: number | null; stderr: string } {
  const run = spawnSync(process.execPath, ['-e', "await import('./tests/browser/harness.mjs')"], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
  });
  return { code: run.status, stderr: run.stderr };
}

describe('the browser harness names its stack or refuses', () => {
  afterEach(() => {
    rmSync(join(ROOT, '.local', 'ports', `${PORT}.lock`), { force: true });
  });

  it('refuses a run with no WEB_URL or API_URL instead of using the demo ports', () => {
    const none = load({});
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain('set WEB_URL and API_URL; there is no default address');
    expect(none.stderr).not.toContain('using the default');
    const half = load({ WEB_URL: `http://127.0.0.1:${PORT}` });
    expect(half.stderr).toContain('set API_URL; there is no default address');
  });

  it('refuses a port a live run holds, and takes over a dead run lock', () => {
    mkdirSync(join(ROOT, '.local', 'ports'), { recursive: true });
    const lock = join(ROOT, '.local', 'ports', `${PORT}.lock`);
    writeFileSync(lock, String(process.pid));
    const env = { WEB_URL: `http://127.0.0.1:${PORT}`, API_URL: 'http://127.0.0.1:65432' };
    expect(load(env).stderr).toContain(`port ${PORT} is held by run pid ${String(process.pid)}`);
    writeFileSync(lock, '999999');
    expect(load(env).stderr).not.toContain('is held by run pid');
  });

  it('guards the default port of an address that names none', () => {
    const lock = join(ROOT, '.local', 'ports', '80.lock');
    mkdirSync(join(ROOT, '.local', 'ports'), { recursive: true });
    writeFileSync(lock, String(process.pid));
    try {
      const env = { WEB_URL: 'http://127.0.0.1', API_URL: 'http://127.0.0.1:65432' };
      expect(load(env).stderr).toContain(`port 80 is held by run pid ${String(process.pid)}`);
    } finally {
      rmSync(lock, { force: true });
    }
  });
});
