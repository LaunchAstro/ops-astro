// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody reads a site answer with its own field reader, the same reading as
// the guarded call's, and passes back only the route's declared fields with
// the media type the provider gave. An answer that is not JSON, by its type
// or its body, or that does not fill the declared fields, is withheld as
// malformed. Custody runs as its own process, and a local stand-in answers in
// place of the provider.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readField } from '../../packages/core-connectors/src/call.ts';
import {
  callConnector,
  siteOperation,
  type CallDependencies,
  type TransportAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { fieldAt } from '../../packages/core-custody/src/egress-answer.ts';
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

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': contentType }).end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  folder = mkdtempSync(join(tmpdir(), 'declared-fields-'));
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

const writeParams = {
  repository: 'agency/site',
  path: 'src/pages/about.astro',
  message: 'm',
  content: 'PHA+',
  sha: 'abc',
  branch: 'main',
};
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

const readParams = { repository: 'agency/site', path: 'src/pages/about.astro', ref: 'main' };
const READ = '/repos/agency/site/contents/src/pages/about.astro?ref=main';
const dispatchRead = async () =>
  await custody.dispatch('source_control', {
    destination: 'source_control',
    path: READ,
    method: 'GET',
    body: '',
    timeoutMs: 5_000,
    maxResponseBytes: 262_144,
  });

it('custody’s field reader reads what the guarded call’s reads, over one table', () => {
  const list = [{ uid: 'dpl_1', meta: { githubCommitSha: 'c0ffee' } }, { uid: 'dpl_2' }];
  const bodies: unknown[] = [
    { deployments: list, content: { sha: 'a' }, sha: 'b', merged: false, number: 7 },
    { deployments: { 0: { uid: 'keyed' } }, content: 'flat' },
    JSON.parse('{"__proto__": {"sha": "own"}, "constructor": "c"}'),
    [{ uid: 'top' }],
    'text',
    null,
  ];
  const paths = [
    'deployments.0.uid',
    'deployments.1.uid',
    'deployments.0.meta.githubCommitSha',
    'deployments.00.uid',
    'deployments.-1.uid',
    'deployments.length',
    'deployments.x',
    'content.sha',
    'sha',
    'merged',
    'number',
    '__proto__.sha',
    'constructor',
    'toString',
    '0.uid',
    'missing.deep.path',
  ];
  for (const one of bodies) {
    for (const path of paths) {
      expect(fieldAt(one, path), `${JSON.stringify(one)} ${path}`).toEqual(readField(one, path));
    }
  }
});

it('custody passes back only the declared fields, with the media type the provider gave', async () => {
  contentType = 'application/json; charset=utf-8';
  body = JSON.stringify({
    name: 'about.astro',
    sha: 'b10b',
    content: 'PHA+',
    encoding: 'base64',
    _links: { self: 'https://api.github.com/x' },
  });
  const outcome = await dispatchRead();
  expect(outcome).toMatchObject({
    kind: 'answered',
    outbound: { ok: true, status: 200, mediaType: 'application/json' },
  });
  const kept = outcome.kind === 'answered' && outcome.outbound.ok ? outcome.outbound.body : '';
  expect(JSON.parse(kept)).toEqual({ sha: 'b10b', content: 'PHA+', encoding: 'base64' });
});

it('a non-JSON content type cannot become a successful write through custody', async () => {
  contentType = 'text/html';
  body = JSON.stringify({ content: { sha: 'blob-after' }, commit: { sha: 'commit-after' } });
  expect(
    await callConnector(siteOperation('site.publish'), writeParams, dependencies(false)),
  ).toEqual({ kind: 'unknown', code: 'PROVIDER_RESPONSE_MALFORMED' });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  expect(result).toEqual({ kind: 'unknown', code: 'PROVIDER_RESPONSE_MALFORMED' });
});

it('a body labelled JSON that does not parse, or does not fill the declared fields, is malformed', async () => {
  contentType = 'application/json';
  for (const text of [
    '{"content": {"sha": "a"',
    '{"content": {"sha": 1}, "commit": {"sha": "b"}}',
  ]) {
    body = text;
    // oxlint-disable-next-line no-await-in-loop
    const result = await callConnector(
      siteOperation('site.publish'),
      writeParams,
      dependencies(true),
    );
    expect(result, text).toEqual({ kind: 'unknown', code: 'PROVIDER_RESPONSE_MALFORMED' });
  }
  body = JSON.stringify({ sha: 'b10b', content: 'PHA+' });
  expect(await dispatchRead()).toEqual({ kind: 'withheld', started: true, reason: 'malformed' });
});

it('a body that is not JSON is malformed, and the borrowing path keeps its own check (control)', async () => {
  contentType = 'text/html';
  body = '<html>not the answer</html>';
  expect(
    await callConnector(siteOperation('site.source.read'), readParams, dependencies(true)),
  ).toEqual({ kind: 'refused', code: 'PROVIDER_RESPONSE_MALFORMED' });
  contentType = 'application/json';
  const commit = randomBytes(20).toString('hex');
  body = JSON.stringify({
    content: { sha: randomBytes(20).toString('hex') },
    commit: { sha: commit },
  });
  const borrowed = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(false),
  );
  expect(borrowed).toMatchObject({ kind: 'ok', value: { 'commit.sha': commit } });
  body = JSON.stringify({ content: { sha: `x${canary}` }, commit: { sha: commit } });
  expect(
    await callConnector(siteOperation('site.publish'), writeParams, dependencies(false)),
  ).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
});
