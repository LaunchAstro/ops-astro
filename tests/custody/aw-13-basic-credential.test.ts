// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 basic credential, at the process level: the trace target's OpenTelemetry
// route takes a project key pair as HTTP Basic (a Bearer key there gets a
// narrower scope and is refused). Custody stores the pair as `user:secret`
// under `scheme: "basic"`, sends it as `authorization: Basic <base64>`, refuses
// a malformed pair at load without writing it, and removes the secret half,
// alone or whole, from anything the target echoes back.

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from './custody-world.ts';

const ROOT = resolve(import.meta.dirname, '../..');

const user = `pk-lf-${randomBytes(8).toString('hex')}`;
const secret = `sk-lf-canary${randomBytes(12).toString('hex')}`;

/** A loopback target that records each request's headers and echoes what it is told to. */
const seen: IncomingHttpHeaders[] = [];
let echo = '{}';
let server: Server;
let world: CustodyWorld;
let custody: Custody;

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.headers);
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
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-target-1',
        destination: 'trace_target',
        header: 'authorization',
        scheme: 'basic',
        value: `${user}:${secret}`,
      },
    ]),
    destinations: [{ key: 'trace_target', origin: `http://127.0.0.1:${String(port)}` }],
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
  const outcome = await custody.dispatch('trace_key', {
    destination: 'trace_target',
    path: '/api/public/otel/v1/traces',
    method: 'POST',
    body: '{}',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  });
  if (outcome.kind !== 'answered' || !outcome.outbound.ok) throw new Error('not answered');
  return outcome.outbound.body;
};

it('AW-13 basic credential: the pair leaves as HTTP Basic, and only to its destination', async () => {
  await dispatch();
  const expected = `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
  expect(seen.at(-1)?.authorization).toBe(expected);
});

it('AW-13 basic credential: an echo of the secret, alone, whole or encoded, comes back redacted', async () => {
  for (const spelling of [
    secret,
    `${user}:${secret}`,
    Buffer.from(`${user}:${secret}`).toString('base64'),
    encodeURIComponent(secret),
  ]) {
    echo = JSON.stringify({ error: `invalid key ${spelling}` });
    // eslint-disable-next-line no-await-in-loop -- one echo at a time
    const body = await dispatch();
    expect(body.includes(secret)).toBe(false);
    expect(body.includes(spelling)).toBe(false);
  }
});

it('AW-13 basic credential: a malformed pair or scheme is refused at load, never written', () => {
  const cases: Record<string, unknown>[] = [
    { header: 'authorization', scheme: 'basic', value: `nocolon${secret}` },
    { header: 'authorization', scheme: 'basic', value: `${user}:${secret}:extra` },
    { header: 'authorization', scheme: 'basic', value: `:${secret}` },
    { header: 'authorization', scheme: 'basic', value: `${user}:` },
    { header: 'x-api-key', scheme: 'basic', value: `${user}:${secret}` },
    { header: 'authorization', scheme: 'Basic', value: `${user}:${secret}` },
    { header: 'authorization', scheme: 'digest', value: `${user}:${secret}` },
    { header: 'authorization', scheme: null, value: `${user}:${secret}` },
    { header: 'authorization', scheme: 'basic', value: `${user}:${secret.slice(0, 7)}` },
  ];
  for (const shape of cases) {
    const file = world.writeCredentials([
      { ref: 'trace_key', kind: 'api_key', account: 'x', destination: 'trace_target', ...shape },
    ]);
    const output = (() => {
      try {
        execFileSync(process.execPath, [join(ROOT, 'packages/core-custody/src/custody-main.ts')], {
          env: { CUSTODY_CREDENTIALS_FILE: file, CUSTODY_DESTINATIONS: '[]' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
        });
        return 'started';
      } catch (error) {
        const failed = error as { stderr: Buffer; status: number };
        return `${String(failed.status)} ${failed.stderr.toString('utf8')}`;
      }
    })();
    expect(output, JSON.stringify(shape['scheme'])).toMatch(
      /^78 custody: credential 0 refused CREDENTIAL_MALFORMED/u,
    );
    expect(output.includes(secret)).toBe(false);
  }
});
