// SPDX-License-Identifier: AGPL-3.0-only
//
// A source read pins its branch in the query, and a branch name may hold a
// `/`, which the guarded call's query writes as `%2F`. A query slot in a
// custody template admits that one escape and nothing else; a path slot
// admits no escape at all. Custody runs as its own process, and a local
// stand-in answers in place of the provider.

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
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';
import {
  siteCustody,
  siteDestination,
  startCustody,
  type Custody,
} from '../../packages/core-custody/src/index.ts';

const canary = `proof-canary-${randomBytes(18).toString('hex')}`;
let server: Server;
let custody: Custody;
let folder: string;
let body = '{}';
let contentType = 'application/json';
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(request.url ?? '');
      response.writeHead(200, { 'content-type': contentType }).end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  folder = mkdtempSync(join(tmpdir(), 'pinned-branch-'));
  const credentialsFile = join(folder, 'credentials.json');
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

const readParams = { repository: 'agency/site', path: 'src/pages/about.astro', ref: 'main' };
const answer = (): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': contentType },
  body: new TextEncoder().encode(body),
});
const dependencies = (reference: boolean): CallDependencies => ({
  transport: () => Promise.resolve(answer()),
  resolve: () => Promise.resolve(['140.82.112.6']),
  credential: () => Promise.resolve(reference ? { ref: 'source_control' } : canary),
  custody: siteCustody(custody),
  record: () => {},
});

const CONTENTS = '/repos/agency/site/contents/src/pages/about.astro';
const dispatch = async (path: string) =>
  await custody.dispatch('source_control', {
    destination: 'source_control',
    path,
    method: 'GET',
    body: '',
    timeoutMs: 5_000,
    maxResponseBytes: 262_144,
  });

it('a source read accepts a pinned branch containing a slash', async () => {
  contentType = 'application/json';
  body = JSON.stringify({ sha: 'abc', content: 'PHA+', encoding: 'base64' });
  const params = { ...readParams, ref: 'approved/branch' };
  expect(
    (await callConnector(siteOperation('site.source.read'), params, dependencies(false))).kind,
  ).toBe('ok');
  seen.length = 0;
  const result = await callConnector(siteOperation('site.source.read'), params, dependencies(true));
  expect(result).toEqual({
    kind: 'ok',
    value: { sha: 'abc', content: 'PHA+', encoding: 'base64' },
  });
  expect(seen).toEqual(['/repos/agency/site/contents/src/pages/about.astro?ref=approved%2Fbranch']);
});

it('custody sends a query value as URLSearchParams writes it', async () => {
  contentType = 'application/json';
  body = JSON.stringify({ sha: 'abc', content: 'PHA+', encoding: 'base64' });
  seen.length = 0;
  for (const ref of [
    'approved%2Fbranch',
    'a%2Fb%2Fc',
    '%2F',
    'a%2Bb',
    'a+b',
    '%2E%2E',
    '..',
    'x*y',
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await dispatch(`${CONTENTS}?ref=${ref}`), ref).toMatchObject({
      kind: 'answered',
      outbound: { ok: true },
    });
  }
  expect(seen).toEqual([
    `${CONTENTS}?ref=approved%2Fbranch`,
    `${CONTENTS}?ref=a%2Fb%2Fc`,
    `${CONTENTS}?ref=%2F`,
    `${CONTENTS}?ref=a%2Bb`,
    `${CONTENTS}?ref=a+b`,
    `${CONTENTS}?ref=%2E%2E`,
    `${CONTENTS}?ref=..`,
    `${CONTENTS}?ref=x*y`,
  ]);
});

it('custody refuses a query value URLSearchParams would not write, before a socket', async () => {
  contentType = 'application/json';
  body = JSON.stringify({ sha: 'abc', content: 'PHA+', encoding: 'base64' });
  seen.length = 0;
  const refused = [
    `${CONTENTS}?ref=%2f%2e`,
    `${CONTENTS}?ref=%2f`,
    `${CONTENTS}?ref=a&b`,
    `${CONTENTS}?ref=a=b`,
    `${CONTENTS}?ref=a%2`,
    `${CONTENTS}?ref=%`,
    `${CONTENTS}?ref=a#b`,
    `${CONTENTS}?ref=a/b`,
    `${CONTENTS}?ref=a b`,
    `${CONTENTS}?ref=`,
    '/repos/agency%2Fsite/x/contents/about.astro?ref=main',
    '/repos/agency/site/contents/src%2Fpages/about.astro?ref=main',
  ];
  for (const path of refused) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await dispatch(path), path).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'bad_path' },
    });
  }
  expect(seen).toEqual([]);
});
