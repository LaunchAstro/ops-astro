// SPDX-License-Identifier: AGPL-3.0-only
//
// A site answer through custody is read as the provider sent it: a body that is
// not valid UTF-8 never confirms a write, and a pinned branch whose name the
// guarded call escapes (a plus) still reaches its source read.

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
import * as custodyExports from '../../packages/core-custody/src/index.ts';
import type { Custody } from '../../packages/core-custody/src/custody.ts';

let server: Server;
let custody: Custody | undefined;
let folder: string;
let body = Buffer.from('{}');
const seen: string[] = [];
const canary = randomBytes(24).toString('hex');

// Run the original borrowed path on the merge base, and the new reference
// path on the PR head. Both controls below run the borrowed path as well.
const hasReferencePath = 'siteDestination' in custodyExports && 'siteCustody' in custodyExports;

beforeAll(async () => {
  if (process.env['BASELINE_RUN'] !== '1') expect(hasReferencePath).toBe(true);
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  folder = mkdtempSync(join(tmpdir(), 'site-answer-'));
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
  if (hasReferencePath) {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    custody = await custodyExports.startCustody({
      credentialsFile,
      destinations: [custodyExports.siteDestination('source_control', origin)],
    });
  }
});

afterAll(async () => {
  await custody?.stop();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

function dependencies(reference: boolean): CallDependencies {
  return {
    resolve: async () => ['140.82.112.6'],
    transport: async () => ({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
    }),
    credential: async () => (reference ? { ref: 'source_control' } : canary),
    ...(custody === undefined ? {} : { custody: custodyExports.siteCustody(custody) }),
    record: () => {},
  };
}

it('malformed UTF-8 never confirms a site write', async () => {
  body = Buffer.concat([
    Buffer.from('{"content":{"sha":"blob'),
    Buffer.from([0xff]),
    Buffer.from('after"},"commit":{"sha":"commit-after"}}'),
  ]);
  const params = {
    repository: 'agency/site',
    path: 'about.astro',
    message: 'm',
    content: 'PHA+',
    sha: 'abc',
    branch: 'main',
  };
  const expected = { kind: 'unknown', code: 'PROVIDER_RESPONSE_MALFORMED' };
  expect(await callConnector(siteOperation('site.publish'), params, dependencies(false))).toEqual(
    expected,
  );
  const result = await callConnector(
    siteOperation('site.publish'),
    params,
    dependencies(hasReferencePath),
  );
  if (hasReferencePath) expect(seen.at(-1)).toBe('/repos/agency/site/contents/about.astro');
  expect(result).toEqual(expected);
});

it('a valid pinned branch with a plus reaches its source read', async () => {
  body = Buffer.from(JSON.stringify({ sha: 'abc', content: 'PHA+', encoding: 'base64' }));
  const params = { repository: 'agency/site', path: 'about.astro', ref: 'approved+branch' };
  const expected = { kind: 'ok', value: { sha: 'abc', content: 'PHA+', encoding: 'base64' } };
  expect(
    await callConnector(siteOperation('site.source.read'), params, dependencies(false)),
  ).toEqual(expected);
  seen.length = 0;
  const result = await callConnector(
    siteOperation('site.source.read'),
    params,
    dependencies(hasReferencePath),
  );
  expect(result).toEqual(expected);
  if (hasReferencePath)
    expect(seen).toEqual(['/repos/agency/site/contents/about.astro?ref=approved%2Bbranch']);
});
