// SPDX-License-Identifier: AGPL-3.0-only
//
// The Vercel function's reconciliation pass (`recoveryPass` in
// `apps/api/function.ts`) runs beside the requests it serves, and a request
// waits on it for a bounded time only. A lookup login that accepts and never
// answers stalls the pass; `/api/sign-in` still answers within
// `RECOVERY_WAIT_MS` and a little. A key whose pass fails runs again on the
// next tick, not on every request: three requests inside one interval log its
// failure once. It goes red if a request waits on the pass with no bound, or if
// a failed pass is retried on every request. No database: the stalled login is
// a socket on this machine that never answers, the failing one a closed port.

import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { ISSUER } from './fixture.ts';

const HOST = 'ops.example.test';
const KEY_ID = 'test/function-recovery-bound@1';
const NOWHERE = 'postgres://app:recovery-bound-canary@127.0.0.1:1/none';
/** `RECOVERY_WAIT_MS` and room for the answer itself. */
const BOUND_MS = 2_000 + 1_500;

const settings = (lookup: string) => ({
  DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
  DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
  DATABASE_URL: NOWHERE,
  DATABASE_LOOKUP_URL: lookup,
  GOTRUE_URL: ISSUER,
  SERVED_HOST: HOST,
  RECOVERY_BUSINESS_KEYS: 'alpha',
});

const signIn = (): Request =>
  new Request(`https://${HOST}/api/sign-in`, { headers: { host: HOST } });

/** Accepts every connection and never says a word, as a stalled database would. */
let silent: Server;
const sockets = new Set<Socket>();
let port = 0;

beforeAll(async () => {
  silent = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    silent.listen(0, '127.0.0.1', resolve);
  });
  const address = silent.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => {
    silent.close(() => resolve());
  });
});

it('a stalled pass does not hold /api/sign-in past the bound', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const handle = createFunctionHandler(
      settings(`postgres://lookup:stalled-canary@127.0.0.1:${String(port)}/none`),
    );
    const started = Date.now();
    const response = await handle(signIn());
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    // The pass still in flight holds the next request no longer than the first.
    const again = Date.now();
    expect((await handle(signIn())).status).toBe(200);
    expect(Date.now() - again).toBeLessThan(BOUND_MS);
  } finally {
    quiet.mockRestore();
  }
}, 15_000);

it('a key whose pass fails waits for the next tick rather than every request', async () => {
  const lines: string[] = [];
  const capture = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    const handle = createFunctionHandler(settings(NOWHERE));
    for (let request = 0; request < 3; request += 1) {
      // eslint-disable-next-line no-await-in-loop -- one request after another
      expect((await handle(signIn())).status).toBe(200);
    }
    // Let a pass the last request started, if any, log its failure too.
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    const failures = lines.filter((line) => line.startsWith('api: reconciliation pass'));
    expect(failures).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('recovery-bound-canary');
  } finally {
    capture.mockRestore();
  }
}, 15_000);
