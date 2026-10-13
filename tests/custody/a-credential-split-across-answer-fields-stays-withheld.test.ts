// SPDX-License-Identifier: AGPL-3.0-only
//
// A provider answer that echoes a site credential through custody is withheld
// whole, however the credential is split across the answer's fields: in an
// order other than the one the connector reads them in, or with an undeclared
// field between the pieces, which the connector's schema filter would drop.
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

const canary = `canary-${randomBytes(18).toString('hex')}`;
let server: Server;
let custody: Custody;
let folder: string;
let body = '{}';
const contentType = 'application/json';

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
  folder = mkdtempSync(join(tmpdir(), 'split-echo-'));
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
});

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

it('a split credential remains withheld when JSON field order differs from schema order', async () => {
  // Each field holds only part of the canary; the schema reads content.sha before commit.sha.
  body = JSON.stringify({
    commit: { sha: canary.slice(12) },
    content: { sha: canary.slice(0, 12) },
  });
  const legacy = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(false),
  );
  expect(legacy).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  // A boolean assertion avoids printing the canary.
  const leaked = result.kind === 'ok' && Object.values(result.value).join('').includes(canary);
  expect(leaked).toBe(false);
  expect(result.kind).toBe('unknown');
});

it('an undeclared string cannot hide a split credential from the schema-filtered result', async () => {
  body = JSON.stringify({
    content: { sha: canary.slice(0, 12) },
    ignored: 'separator',
    commit: { sha: canary.slice(12) },
  });
  expect(
    await callConnector(siteOperation('site.publish'), writeParams, dependencies(false)),
  ).toEqual({ kind: 'unknown', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  const result = await callConnector(
    siteOperation('site.publish'),
    writeParams,
    dependencies(true),
  );
  const leaked = result.kind === 'ok' && Object.values(result.value).join('').includes(canary);
  expect(leaked).toBe(false);
});
