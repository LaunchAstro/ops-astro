// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled sweep entry (`pnpm automations:sweep`) with `AUTOMATION_FIRING`
// anything but the exact `on`: it says firing is off and exits 0 before it
// reads another setting or opens a connection. Every login it is given points
// at a listener that counts the connections made to it, and a login held
// elsewhere and a malformed key list sit beside them, so reading either would
// show.

import { spawn } from 'node:child_process';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepEntry } from '../../apps/automations/sweep.ts';

const ROOT = join(import.meta.dirname, '../..');

let listener: Server;
let connections = 0;
let login = '';

beforeAll(async () => {
  listener = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, '127.0.0.1', resolve);
  });
  login = `postgres://nobody:nothing@127.0.0.1:${(listener.address() as AddressInfo).port}/none`;
});

afterAll(async () => {
  await new Promise((resolve) => {
    listener.close(resolve);
  });
});

beforeEach(() => {
  connections = 0;
});

/** Every other setting the entry reads once firing is on. */
const settings = (): Record<string, string> => ({
  DATABASE_URL: login,
  DATABASE_LOOKUP_URL: login,
  DATABASE_ADMIN_URL: login,
  AUTOMATION_BUSINESS_KEYS: '',
});

/** The entry as launchd runs it: its own process, with only these settings. */
async function ranAsProcess(
  environment: Record<string, string>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, ['apps/automations/sweep.ts'], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

describe('the scheduled entry with firing not on', () => {
  it.each([
    ['unset', undefined],
    ['off', 'off'],
    ['On', 'On'],
    ['on with a trailing space', 'on '],
  ])('%s: firing off, exit 0, no connection opened', async (_name, firing) => {
    const environment = {
      ...settings(),
      ...(firing === undefined ? {} : { AUTOMATION_FIRING: firing }),
    };
    expect(await sweepEntry(environment)).toEqual({
      code: 0,
      line: 'automation sweep: firing off',
    });
    expect(connections).toBe(0);
  });

  it('as its own process with the setting unset, it prints firing off and exits 0', async () => {
    const ran = await ranAsProcess(settings());
    expect(ran).toEqual({ code: 0, stdout: 'automation sweep: firing off\n', stderr: '' });
    expect(connections).toBe(0);
  }, 30_000);
});
