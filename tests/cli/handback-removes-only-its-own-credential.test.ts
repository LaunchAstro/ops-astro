// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's `task.handback` removes the saved delegation only if it is still
// the one it spent, and it compares and removes under the credentials' lock,
// the lock a pickup holds while it saves a new one. So a pickup in another
// process can never land between the compare and the removal. Here the test
// holds the lock as that pickup would, while the handback runs as its own
// process against a stand-in API on a loopback port.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ENTRY = join(import.meta.dirname, '..', '..', 'apps', 'cli', 'main.ts');

let folder: string;
let server: Server;
let origin: string;
let handedBack: () => void;
let arrived: Promise<void>;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'cli-handback-'));
  arrived = new Promise((resolve) => {
    handedBack = resolve;
  });
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ command: 'task.handback', detail: { outcome: 'completed' } }));
      handedBack();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});

afterEach(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
  });
  rmSync(folder, { recursive: true, force: true });
});

function handback(): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      ENTRY,
      'task.handback',
      '--agent',
      '--business',
      'alpha',
      '--api',
      origin,
      '--json',
      '{"leaseId":"lease-1","fence":1,"outcome":"completed","report":{}}',
    ],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        OPS_ASTRO_TOKEN: 'agent-bearer',
        OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
        OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
      },
      stdio: 'ignore',
    },
  );
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code ?? -1));
  });
}

describe('a handback removes only the credential it spent', () => {
  it('it waits for the lock, then keeps a new credential a pickup saved meanwhile', async () => {
    const delegation = join(folder, 'delegation');
    writeFileSync(delegation, 'spent-credential\n', { mode: 0o600 });
    const lock = join(folder, 'token.lock');
    mkdirSync(lock);
    const ended = handback();
    await arrived;
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(readFileSync(delegation, 'utf8')).toBe('spent-credential\n');
    // The pickup's save, as the lock holder does it: a new file renamed into place.
    writeFileSync(`${delegation}.pickup.tmp`, 'new-credential\n', { mode: 0o600 });
    renameSync(`${delegation}.pickup.tmp`, delegation);
    rmdirSync(lock);
    expect(await ended).toBe(0);
    expect(readFileSync(delegation, 'utf8')).toBe('new-credential\n');
  });

  it('with no pickup in between, it removes the spent credential', async () => {
    const delegation = join(folder, 'delegation');
    writeFileSync(delegation, 'spent-credential\n', { mode: 0o600 });
    expect(await handback()).toBe(0);
    expect(existsSync(delegation)).toBe(false);
  });
});
