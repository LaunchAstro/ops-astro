// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T (SEC-P3A-1 S1): a provider's refusal names why, and one status can
// mean two things. The login provider answers 422 both for an address that
// holds a login (`email_exists`) and for a password it will not take
// (`weak_password`). So custody passes on the refusal's code, and only that:
// a lower-case token of at most 64 characters read from the answer's
// `error_code`, never the answer itself, whose message may carry anything.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';

/** A marker in the refusal's message: it must never leave custody. */
const CANARY = `canary-${randomBytes(9).toString('hex')}`;
let answer = '';
let server: Server;
let custody: Custody;
let folder: string;
/** A stored credential spelled as one short lower-case token. */
const SECRET = 'custody_canary_secret_token';

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(422, { 'content-type': 'application/json' }).end(answer);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'c39t-code-'));
  const credentialsFile = join(folder, 'credentials.json');
  const credential = {
    ref: 'auth_key',
    kind: 'api_key',
    account: 'auth-1',
    destination: 'auth',
    header: 'authorization',
    value: `key-${randomBytes(18).toString('hex')}`,
  };
  const token = { ...credential, ref: 'token_key', account: 'auth-2', value: SECRET };
  writeFileSync(credentialsFile, JSON.stringify([credential, token]), { mode: 0o600 });
  custody = await startCustody({ credentialsFile, destinations: [{ key: 'auth', origin }] });
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

/** The outbound half of the outcome, as text, so a test can look for the canary in all of it. */
async function refusedWith(body: string, ref = 'auth_key'): Promise<string> {
  answer = body;
  const outcome = await custody.dispatch(ref, {
    destination: 'auth',
    path: '/auth/v1/admin/users',
    method: 'POST',
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  });
  return JSON.stringify(outcome.kind === 'answered' ? outcome.outbound : outcome);
}

it('C39-T provider refusal: a 422 names its error_code, and nothing else of the answer leaves custody', async () => {
  const msg = `Password is known to be weak and easy to guess: ${CANARY}`;
  const text = await refusedWith(JSON.stringify({ code: 422, error_code: 'weak_password', msg }));
  expect(JSON.parse(text)).toStrictEqual({
    ok: false,
    fault: 'status',
    status: 422,
    code: 'weak_password',
  });
  expect(text).not.toContain(CANARY);
});

it('C39-T provider refusal: an error_code that is not one short lower-case token is no code at all', async () => {
  const bodies = [
    JSON.stringify({ error_code: `Weak_${CANARY}` }),
    JSON.stringify({ error_code: 'x'.repeat(65) }),
    JSON.stringify({ error_code: 'weak password' }),
    JSON.stringify({ error_code: 422 }),
    JSON.stringify({ msg: CANARY }),
    JSON.stringify([{ error_code: 'weak_password' }]),
    `{"error_code":"weak_password"`,
    CANARY,
  ];
  for (const body of bodies) {
    // oxlint-disable-next-line no-await-in-loop
    const text = await refusedWith(body);
    expect(JSON.parse(text), body).toStrictEqual({ ok: false, fault: 'status', status: 422 });
    expect(text).not.toContain(CANARY);
  }
});

it('C39-T provider refusal: a code is one the login provider names, so a stored credential spelled as a token never leaves custody as one', async () => {
  const bodies = [SECRET, 'custody_canary_secret', 'refresh_token_not_found'].map((code) =>
    JSON.stringify({ code: 422, error_code: code, msg: 'refused' }),
  );
  for (const body of bodies) {
    // oxlint-disable-next-line no-await-in-loop
    const text = await refusedWith(body, 'token_key');
    expect(JSON.parse(text), body).toStrictEqual({ ok: false, fault: 'status', status: 422 });
    expect(text).not.toContain(SECRET);
  }
  for (const code of ['email_exists', 'user_not_found', 'weak_password']) {
    // oxlint-disable-next-line no-await-in-loop
    const text = await refusedWith(JSON.stringify({ error_code: code }), 'token_key');
    expect(JSON.parse(text)).toMatchObject({ code });
  }
});
