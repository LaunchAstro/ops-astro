// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody withholds a site answer after sending it, so a withheld answer is
// its own outcome, never a refusal before sending: custody's process replies
// `withheld`, the handle reads it as started, and the guarded call answers a
// read as refused and a write as unknown, since the provider may have acted.
// A route's declared fields are checked when custody loads its destinations.
// Custody runs as its own process, and a local stand-in answers in place of
// the provider.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  callConnector,
  siteOperation,
  type CallDependencies,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseDestinations,
  siteCustody,
  siteDestination,
  startCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';

const canary = `proof-canary-${randomBytes(18).toString('hex')}`;
const seen: string[] = [];
let server: Server;
let custody: Custody;
let folder: string;
let credentialsFile: string;
let body = '{}';

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  folder = mkdtempSync(join(tmpdir(), 'withheld-answer-'));
  credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'source_control',
        kind: 'api_key',
        account: 'proof',
        destination: 'source_control',
        header: 'authorization',
        value: canary,
      },
    ]),
    { mode: 0o600 },
  );
  custody = await startCustody({
    credentialsFile,
    destinations: [siteDestination('source_control', origin)],
  });
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

const PUBLISH = '/repos/agency/site/contents/src/pages/about.astro';
const writeParams = {
  repository: 'agency/site',
  path: 'src/pages/about.astro',
  message: 'm',
  content: 'PHA+',
  sha: 'abc',
  branch: 'main',
};
const readParams = { repository: 'agency/site', path: 'src/pages/about.astro', ref: 'main' };

function byReference(): { deps: CallDependencies; codes: string[] } {
  const codes: string[] = [];
  return {
    codes,
    deps: {
      transport: () => Promise.resolve({ kind: 'failed' }),
      resolve: () => Promise.resolve(['140.82.112.6']),
      credential: (ref) => Promise.resolve({ ref }),
      custody: siteCustody(custody),
      record: (code) => codes.push(code),
    },
  };
}

it('a write whose answer custody withheld answers unknown, and a read refused, once sent', async () => {
  seen.length = 0;
  body = JSON.stringify({
    content: { sha: canary },
    commit: { sha: 'c0ffee', parents: [{ sha: 'decade' }] },
  });
  const write = byReference();
  const written = await callConnector(
    siteOperation('site.source.propose'),
    writeParams,
    write.deps,
  );
  expect(written).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  expect(write.codes).toEqual(['PROVIDER_CREDENTIAL_ECHOED']);
  body = JSON.stringify({ sha: 'b10b', content: canary, encoding: 'base64' });
  const read = byReference();
  expect(await callConnector(siteOperation('site.source.read'), readParams, read.deps)).toEqual({
    kind: 'refused',
    code: 'PROVIDER_CREDENTIAL_ECHOED',
  });
  // Both went out: the provider was asked before custody judged its answer.
  expect(seen).toEqual([`PUT ${PUBLISH}`, `GET ${PUBLISH}?ref=main`]);
});

it('custody’s process answers a withheld dispatch as started, never as a refusal before sending', async () => {
  body = JSON.stringify({
    content: { sha: canary.slice(0, 20) },
    commit: { sha: canary.slice(20), parents: [{ sha: 'decade' }] },
  });
  const outcome = await custody.dispatch('source_control', {
    destination: 'source_control',
    path: PUBLISH,
    method: 'PUT',
    body: '{}',
    timeoutMs: 5_000,
    maxResponseBytes: 262_144,
  });
  // A boolean first, so a failure never prints the canary's pieces.
  expect(JSON.stringify(outcome).includes(canary.slice(20))).toBe(false);
  expect(outcome).toEqual({ kind: 'withheld', started: true, reason: 'echoed' });
  expect(custody.stderr().includes(canary)).toBe(false);
});

it('the custody port reads each withheld reason as its own answer, never a refusal', async () => {
  const codes = { echoed: 'PROVIDER_CREDENTIAL_ECHOED', malformed: 'PROVIDER_RESPONSE_MALFORMED' };
  for (const reason of ['echoed', 'malformed'] as const) {
    const port = siteCustody({
      dispatch: () => Promise.resolve({ kind: 'withheld', started: true, reason }),
    });
    // oxlint-disable-next-line no-await-in-loop
    const answered = await port(
      {
        url: new URL(`https://api.github.com${PUBLISH}`),
        address: '140.82.112.6',
        family: 4,
        method: 'PUT',
        headers: {},
        timeoutMs: 1_000,
        maxBytes: 1_024,
      },
      { ref: 'source_control' },
    );
    expect(answered).toEqual({ kind: 'withheld', code: codes[reason] });
  }
});

const load = (fields: unknown) =>
  parseDestinations([
    {
      key: 'source_control',
      origin: 'https://api.github.com',
      post: false,
      routes: [{ method: 'GET', template: '/repos/{owner}/{name}', fields }],
    },
  ]);

it('a route’s declared fields are refused at load when malformed', async () => {
  expect(load({ sha: 'string', 'content.size': 'number', merged: 'boolean' })).toMatchObject({
    ok: true,
  });
  const malformed: unknown[] = [
    undefined,
    'sha',
    ['sha'],
    { sha: 'object' },
    { sha: 'String' },
    { '': 'string' },
    { 'content..sha': 'string' },
    { '.sha': 'string' },
    { 'sha ': 'string' },
    { a: 'string', b: 'string', c: 'string', d: 'string', e: 'string' },
  ];
  for (const fields of malformed) {
    expect(load(fields), JSON.stringify(fields)).toMatchObject({
      ok: false,
      code: 'DESTINATION_MALFORMED',
    });
  }
  // A template route with no fields at all is no route either.
  const bare = { method: 'GET', template: '/repos/{owner}/{name}' };
  expect(
    parseDestinations([{ key: 'k', origin: 'https://a.example', routes: [bare] }]),
  ).toMatchObject({ ok: false });
  // Custody's own process refuses to start on one.
  const started = startCustody({
    credentialsFile,
    destinations: [
      {
        key: 'source_control',
        origin: 'https://api.github.com',
        routes: [{ method: 'GET', template: '/x', fields: { sha: 'object' } }],
      } as never,
    ],
  });
  await expect(started).rejects.toThrow('custody did not start');
});
