// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13, custody's side of trace retention: a destination may name a fixed
// header custody adds to every request, and the few non-POST routes it
// answers (the trace store's expiry and the read that confirms it). Both come
// from the destination's own configuration, never from a caller; anything
// else a caller asks is refused before a socket exists.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  parseDestinations,
  startCustody,
  type Custody,
  type Destination,
} from '../../packages/core-custody/src/index.ts';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

const HEADER = 'x-langfuse-ingestion-version';
const seen: Seen[] = [];
const canary = `canary-${randomBytes(18).toString('hex')}`;
let server: Server;
let custody: Custody;
let other: Custody;
let folder: string;
let redirecting = false;

function destinationAt(origin: string): Destination {
  return {
    key: 'trace_target',
    origin,
    headers: { [HEADER]: '4' },
    routes: [
      { method: 'DELETE', path: '/api/public/traces' },
      { method: 'GET', path: '/api/public/traces/*' },
    ],
  } as Destination;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
      if (redirecting) {
        response.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }).end();
        return;
      }
      // The target echoes the credential it was handed: custody must redact it.
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ echoed: request.headers.authorization ?? null }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'aw13-routes-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-target-1',
        destination: 'trace_target',
        header: 'authorization',
        value: canary,
      },
      {
        ref: 'plain_key',
        kind: 'api_key',
        account: 'plain-1',
        destination: 'plain',
        header: 'authorization',
        value: canary,
      },
    ]),
    { mode: 0o600 },
  );
  custody = await startCustody({ credentialsFile, destinations: [destinationAt(origin)] });
  // The same origin listed with no fixed header and no route of its own.
  other = await startCustody({ credentialsFile, destinations: [{ key: 'plain', origin }] });
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await other?.stop();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

const request = (method: string, path: string, body = '{}') => ({
  destination: 'trace_target',
  path,
  method,
  body,
  timeoutMs: 2_000,
  maxResponseBytes: 4_096,
});

async function dispatch(method: string, path: string, on: Custody = custody) {
  const ref = on === custody ? 'trace_key' : 'plain_key';
  const asked = {
    ...request(method, path),
    destination: on === custody ? 'trace_target' : 'plain',
  };
  return await on.dispatch(ref, asked as never);
}

it('AW-13 custody header: every request to the destination carries its fixed header, and a caller supplies none', async () => {
  seen.length = 0;
  const posted = await dispatch('POST', '/api/public/otel/v1/traces');
  const deleted = await dispatch('DELETE', '/api/public/traces');
  const read = await dispatch('GET', '/api/public/traces/0123456789abcdef0123456789abcdef');
  for (const outcome of [posted, deleted, read]) {
    expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: true } });
  }
  expect(seen.map((one) => [one.method, one.headers[HEADER]])).toEqual([
    ['POST', '4'],
    ['DELETE', '4'],
    ['GET', '4'],
  ]);
  // A request naming headers of its own is refused whole, and nothing is sent.
  seen.length = 0;
  for (const headers of [{ [HEADER]: '9' }, { authorization: 'Bearer x' }, { 'X-Other': '1' }]) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await custody.raw({
      type: 'dispatch',
      credentialRef: 'trace_key',
      request: { ...request('POST', '/api/public/otel/v1/traces'), headers },
    });
    expect(refused).toMatchObject({ type: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
  }
  expect(seen).toHaveLength(0);
  // A destination with no fixed header sends none.
  await dispatch('POST', '/api/public/otel/v1/traces', other);
  expect(seen[0]?.headers[HEADER]).toBeUndefined();
});

it('AW-13 custody expiry route: DELETE and GET only on the destination’s own routes, any other method refused', async () => {
  seen.length = 0;
  const refusedPaths: [string, string][] = [
    ['DELETE', '/api/public/otel/v1/traces'],
    ['DELETE', '/api/public/traces/extra'],
    ['DELETE', '/api/public/Traces'],
    ['GET', '/api/public/traces'],
    ['GET', '/api/public/traces/'],
    ['GET', '/api/public/traces/a/b'],
    ['GET', '/api/public/traces/..'],
    ['GET', '/api/public/otel/v1/traces'],
  ];
  for (const [method, path] of refusedPaths) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await dispatch(method, path);
    expect(outcome, `${method} ${path}`).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'bad_path' },
    });
  }
  // Another destination has no DELETE route at all.
  expect(await dispatch('DELETE', '/api/public/traces', other)).toMatchObject({
    kind: 'answered',
    outbound: { ok: false, fault: 'bad_path' },
  });
  // Methods custody never sends, whatever the route: refused before any answer.
  for (const method of ['PUT', 'PATCH', 'delete', 'Delete', 'OPTIONS', 'CONNECT', '']) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await dispatch(method, '/api/public/traces');
    expect(outcome, method).toMatchObject({ kind: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
  }
  expect(seen).toHaveLength(0);
});

it('AW-13 custody expiry route: a redirect on a delete is answered, never followed', async () => {
  seen.length = 0;
  redirecting = true;
  try {
    expect(await dispatch('DELETE', '/api/public/traces')).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'redirect', status: 307 },
    });
  } finally {
    redirecting = false;
  }
  expect(seen).toHaveLength(1);
});

it('AW-13 custody expiry route: the credential canary never comes back in a body or custody’s stderr', async () => {
  const outcome = await dispatch('DELETE', '/api/public/traces');
  expect(JSON.stringify(outcome)).not.toContain(canary);
  expect(JSON.stringify(outcome)).toContain('[redacted]');
  expect(custody.stderr()).not.toContain(canary);
});

it('AW-13 custody header: a destination’s fixed header or route is refused at load when malformed', () => {
  const origin = 'https://trace.example.com';
  const load = (extra: Record<string, unknown>) =>
    parseDestinations([{ key: 'trace_target', origin, ...extra }]);
  expect(load({ headers: { [HEADER]: '4' } })).toMatchObject({ ok: true });
  const refused: Record<string, unknown>[] = [
    { headers: { [HEADER]: '4\r\nx-injected: 1' } },
    { headers: { [HEADER]: '4\n' } },
    { headers: { [HEADER]: '' } },
    { headers: { [HEADER]: ' 4' } },
    { headers: { [HEADER]: 4 } },
    { headers: { [HEADER]: '4\t' } },
    { headers: { [HEADER]: 'é' } },
    { headers: { 'X-Langfuse-Ingestion-Version': '4' } },
    { headers: { 'x-a:b': '1' } },
    { headers: { 'x a': '1' } },
    { headers: { authorization: 'Bearer planted' } },
    { headers: { 'x-api-key': 'planted' } },
    { headers: { host: 'elsewhere.example.com' } },
    { headers: { 'content-length': '0' } },
    { headers: { 'content-type': 'text/plain' } },
    { headers: { cookie: 'a=b' } },
    { headers: { 'proxy-authorization': 'x' } },
    { headers: { 'transfer-encoding': 'chunked' } },
    { headers: [] },
    { headers: 'x' },
    { routes: [{ method: 'POST', path: '/api/public/traces' }] },
    { routes: [{ method: 'PUT', path: '/api/public/traces' }] },
    { routes: [{ method: 'delete', path: '/api/public/traces' }] },
    { routes: [{ method: 'DELETE', path: '/api/../traces' }] },
    { routes: [{ method: 'DELETE', path: 'api/public/traces' }] },
    { routes: [{ method: 'DELETE', path: '/api/public/traces/*' }] },
    { routes: [{ method: 'GET', path: '/api/*/traces' }] },
    { routes: [{ method: 'GET', path: '//evil.example.com/x' }] },
    { routes: [{ method: 'DELETE', path: '/api/public/traces', extra: true }] },
    { routes: {} },
  ];
  for (const extra of refused) {
    expect(load(extra), JSON.stringify(extra)).toMatchObject({
      ok: false,
      code: 'DESTINATION_MALFORMED',
    });
  }
});
