// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: the journey command refuses before it starts anything. A malformed
// port, another stack's port and a port something already answers on each
// exit 2 naming the reason (RN-03). Docker is `false` here, so the command
// can start nothing even if it failed to refuse.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const evidence = mkdtempSync(join(tmpdir(), 'journey-refusals-'));

function journey(...args: string[]): { code: number | null; out: string } {
  const run = spawnSync(
    process.execPath,
    ['scripts/local/journey.mjs', '--evidence', evidence, ...args],
    // A docker that always fails: whatever the command decides, it can start nothing.
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', DOCKER: '/usr/bin/false' },
    },
  );
  return { code: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('the journey command refuses before starting anything', () => {
  let held: Server;
  let port = 0;

  beforeAll(async () => {
    held = createServer();
    await new Promise<void>((done) => {
      held.listen(0, '127.0.0.1', () => {
        done();
      });
    });
    port = (held.address() as { port: number }).port;
  });

  afterAll(() => {
    held.close();
    rmSync(evidence, { recursive: true, force: true });
  });

  it.each([
    ['abc', 'pg port abc is not a port number'],
    ['0x1F90', 'pg port 0x1F90 is not a port number'],
    ['70000', 'pg port 70000 is not a port number'],
    [' 54430', 'pg port  54430 is not a port number'],
  ])('refuses a malformed port %j', (value, reason) => {
    const run = journey('--pg-port', value);
    expect(run.code).toBe(2);
    expect(run.out).toContain(`refused: ${reason}`);
    expect(run.out).not.toContain('stack: Postgres');
  });

  it('refuses the live pair and a port in use, each by name', () => {
    const live = journey('--web-port', '5190');
    expect(live.code).toBe(2);
    expect(live.out).toContain('refused: web port 5190 belongs to another stack');
    const used = journey('--api-port', String(port));
    expect(used.code).toBe(2);
    expect(used.out).toContain(`refused: api port ${String(port)} is already in use`);
    expect(used.out).not.toContain('stack: Postgres');
  });
});
