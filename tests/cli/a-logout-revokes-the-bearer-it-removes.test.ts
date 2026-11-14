// SPDX-License-Identifier: AGPL-3.0-only
//
// Logout ends at the server the very session whose file it removes (#2425,
// S2444-1). A login may publish a new bearer while logout waits for the
// credentials lock. Had logout read the bearer before taking the lock, it
// would revoke the earlier session, remove the new file and report
// "ended":true while a copy of the new bearer stayed usable. The bearer is
// read under the same lock that removes it.
//
// The CLI's lock wait holds its whole thread, so the race runs with a real
// logout process: the test holds the lock, starts logout, publishes the new
// bearer as a login would, then lets the lock go.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const MAIN = join(import.meta.dirname, '../../apps/cli/main.ts');
const EARLIER = 'bearer-earlier-session-a-3c1f';
const NEWER = 'bearer-newer-session-b-7d2e';

let server: Server;
let api = '';
const bearers: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    bearers.push(request.headers.authorization ?? '');
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ended":1}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  api = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const pause = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

it('a bearer published while logout waits for the lock is the one ended at the server', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cli-logout-lock-'));
  const token = join(folder, 'token');
  const lock = `${token}.lock`;
  try {
    writeFileSync(token, `${EARLIER}\n`, { mode: 0o600 });
    mkdirSync(lock);
    const child = spawn(process.execPath, [MAIN, 'logout'], {
      env: {
        ...process.env,
        OPS_ASTRO_API_URL: api,
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_TOKEN_FILE: token,
        OPS_ASTRO_DELEGATION_FILE: join(folder, 'pickup'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });
    // Logout has started and waits on the lock (it waits up to 3 s); a login publishes B.
    await pause(2_000);
    writeFileSync(token, `${NEWER}\n`, { mode: 0o600 });
    rmdirSync(lock);
    expect(await exited).toBe(0);
    expect(existsSync(token)).toBe(false);
    expect(bearers).toStrictEqual([`Bearer ${NEWER}`]);
    expect(JSON.parse(out)).toStrictEqual({ ok: true, ended: true });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30_000);
