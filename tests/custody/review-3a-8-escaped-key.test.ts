// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, n=8: custody redacts the raw bytes of the
// provider's answer (custody-main.ts `redact`), and the broker then JSON-parses
// those bytes (broker-settle.ts `settlementOf`). A provider that echoes the key
// JSON-escaped, `\/` for a slash or `c` for its first character, passes the
// byte match and the key is whole again in the parsed answer text.

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from './custody-world.ts';

// Starts with 'c' and holds a '/', so both escaped spellings exist.
const key = `canary-${randomBytes(9).toString('hex')}/${randomBytes(9).toString('hex')}`;

let echo = '{}';
let server: Server;
let world: CustodyWorld;
let custody: Custody;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(echo);
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  world = await openCustodyWorld();
  const port = (server.address() as AddressInfo).port;
  custody = await startCustody({
    credentialsFile: world.writeCredentials([
      {
        ref: 'echo_key',
        kind: 'api_key',
        account: 'echo-account-1',
        destination: 'echo_target',
        header: 'authorization',
        value: key,
      },
    ]),
    destinations: [{ key: 'echo_target', origin: `http://127.0.0.1:${String(port)}` }],
  });
});

afterAll(async () => {
  await custody?.stop();
  await world?.close();
  await new Promise<void>((done) => {
    server?.close(() => {
      done();
    });
  });
});

const dispatch = async (): Promise<string> => {
  const outcome = await custody.dispatch('echo_key', {
    destination: 'echo_target',
    path: '/v1/echo',
    method: 'POST',
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  });
  if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
  return outcome.outbound.body;
};

const SPELLINGS: readonly [string, string][] = [
  ['slash escaped as \\/', key.replaceAll('/', '\\/')],
  ['first character escaped as \\u0063', `\\u0063${key.slice(1)}`],
];

it('REVIEW-3A-8: control, the key echoed verbatim comes back redacted', async () => {
  echo = JSON.stringify({ error: `invalid key ${key}` });
  const body = await dispatch();
  expect(body.includes(key)).toBe(false);
});

for (const [name, spelling] of SPELLINGS) {
  it(`REVIEW-3A-8: a key echoed JSON-escaped (${name}) is not whole again in the parsed answer`, async () => {
    // Raw JSON text, so the escape reaches custody as the provider sent it.
    echo = `{"error":"invalid key ${spelling}"}`;
    const body = await dispatch();
    const parsed = JSON.parse(body) as { error?: unknown };
    expect(String(parsed.error).includes(key), `parsed answer text holds the key (${name})`).toBe(
      false,
    );
    expect(JSON.stringify(parsed).includes(key)).toBe(false);
  });
}
