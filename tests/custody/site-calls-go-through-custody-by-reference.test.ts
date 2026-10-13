// SPDX-License-Identifier: AGPL-3.0-only
//
// The site's guarded calls through custody's own process: custody's routes
// for each site entry come from the connector catalogue, every catalogued
// call that uses the entry and nothing else, and a call the catalogue gains
// later is admitted with no second list. The caller answers only a reference;
// custody adds the token, passes back only the declared fields, and withholds
// an answer that echoes the token, so the token is never back in the caller's
// process. A local stand-in answers
// in place of either provider.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SITE_OPERATIONS,
  callConnector,
  connectorRelease,
  type CallDependencies,
  type OperationRegistration,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseDestinations,
  routeTemplate,
  siteCustody,
  siteDestination,
  startCustody,
  type Custody,
  type Destination,
} from '../../packages/core-custody/src/index.ts';

const tokens = {
  source_control: `canary-${randomBytes(18).toString('hex')}`,
  hosting: `canary-${randomBytes(18).toString('hex')}`,
};
const seen: { method: string; url: string; authorization: string | undefined }[] = [];
let echoing = false;
let server: Server;
let custody: Custody;
let folder: string;
let origin: string;

const op = (name: string) =>
  SITE_OPERATIONS.find((entry) => entry.declaration.operation_name === name)!;

/** A read the catalogue gains later, on the hosting entry. */
const laterConnector = {
  ...op('site.deployment.read').connector,
  pathTemplate: '/v9/projects/{project}/domains',
  responseSchema: { 'domains.0.name': 'string' },
} as const;
const LATER: OperationRegistration = {
  declaration: {
    ...op('site.deployment.read').declaration,
    connector_release: connectorRelease(laterConnector),
  },
  connector: laterConnector,
};

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      const token = (request.headers.authorization ?? '').replace('Bearer ', '');
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          deployments: [
            { uid: echoing ? `dpl_${token}` : 'dpl_1', meta: { githubCommitSha: 'c0ffee' } },
          ],
          domains: [{ name: 'www.example.com' }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'site-custody-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify(
      (['source_control', 'hosting'] as const).map((ref) => ({
        ref,
        kind: 'api_key',
        account: `${ref}-1`,
        destination: ref,
        header: 'authorization',
        value: tokens[ref],
      })),
    ),
    { mode: 0o600 },
  );
  custody = await startCustody({
    credentialsFile,
    destinations: [
      siteDestination('source_control', origin),
      siteDestination('hosting', origin, [...SITE_OPERATIONS, LATER]),
    ],
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

function deps(): { deps: CallDependencies; byCaller: number[]; codes: string[] } {
  const byCaller: number[] = [];
  const codes: string[] = [];
  return {
    byCaller,
    codes,
    deps: {
      transport: () => {
        byCaller.push(1);
        return Promise.resolve({ kind: 'failed' });
      },
      resolve: () => Promise.resolve(['76.76.21.21']),
      credential: (ref) => Promise.resolve({ ref }),
      custody: siteCustody(custody),
      record: (code) => codes.push(code),
    },
  };
}

const expected = (entry: string) =>
  SITE_OPERATIONS.filter((one) => one.connector.credential === entry)
    .map((one) => `${one.connector.method} ${routeTemplate(one)}`)
    .filter((route, at, all) => all.indexOf(route) === at)
    .toSorted();
const listed = (destination: Destination) =>
  (destination.routes ?? [])
    .map((route) => `${route.method} ${'template' in route ? route.template : route.path}`)
    .toSorted();

it('custody holds each site entry’s catalogued calls as fixed templates, and no others', () => {
  const hosting = siteDestination('hosting', 'https://api.vercel.com');
  const source = siteDestination('source_control', 'https://api.github.com');
  expect(listed(hosting)).toEqual(expected('hosting'));
  expect(listed(source)).toEqual(expected('source_control'));
  expect(listed(hosting)).toContain(
    'GET /v6/deployments?projectId={project}&sha={sha}&target=production&limit=1',
  );
  expect(listed(source)).toContain(
    'GET /repos/{repository}/{repository}/contents/{path*}?ref={ref}',
  );
  expect([hosting.post, source.post]).toEqual([false, false]);
  // Custody's own load takes them as they are.
  expect(parseDestinations([hosting, source])).toMatchObject({ ok: true });
});

it('a site call by reference reaches the provider with the token custody adds, and the caller holds none', async () => {
  seen.length = 0;
  const call = deps();
  const looked = await callConnector(
    op('site.deployment.lookup'),
    { project: 'prj_abc', sha: 'c0ffee' },
    call.deps,
  );
  const read = await callConnector(
    op('site.source.read'),
    { repository: 'agency/site', path: 'src/pages/about.astro', ref: 'main' },
    call.deps,
  );
  const later = await callConnector(LATER, { project: 'prj_abc' }, call.deps);
  expect(looked).toEqual({
    kind: 'ok',
    value: { 'deployments.0.uid': 'dpl_1', 'deployments.0.meta.githubCommitSha': 'c0ffee' },
  });
  // The stand-in answers no contents fields: custody sent it, and withheld the answer as malformed.
  expect(read).toEqual({ kind: 'refused', code: 'PROVIDER_RESPONSE_MALFORMED' });
  expect(later).toEqual({ kind: 'ok', value: { 'domains.0.name': 'www.example.com' } });
  expect(seen.map((one) => [one.url, one.authorization])).toEqual([
    [
      '/v6/deployments?projectId=prj_abc&sha=c0ffee&target=production&limit=1',
      `Bearer ${tokens.hosting}`,
    ],
    [
      '/repos/agency/site/contents/src/pages/about.astro?ref=main',
      `Bearer ${tokens.source_control}`,
    ],
    ['/v9/projects/prj_abc/domains', `Bearer ${tokens.hosting}`],
  ]);
  expect(call.byCaller).toEqual([]);
});

it('a call off the catalogue is refused by custody before a socket, and an answer echoing the token is withheld', async () => {
  seen.length = 0;
  const call = deps();
  // The later read's route is not on the source entry's list.
  const off = await callConnector(
    LATER,
    { project: 'prj_abc' },
    {
      ...call.deps,
      credential: () => Promise.resolve({ ref: 'hosting' }),
      custody: async (request, reference) =>
        await siteCustody(custody)(request, { ...reference, ref: 'source_control' }),
    },
  );
  expect(off).toEqual({ kind: 'refused', code: 'CUSTODY_ROUTE_REFUSED' });
  expect(seen).toEqual([]);
  echoing = true;
  try {
    const echoed = await callConnector(
      op('site.deployment.lookup'),
      { project: 'prj_abc', sha: 'c0ffee' },
      call.deps,
    );
    expect(JSON.stringify(echoed).includes(tokens.hosting)).toBe(false);
    expect(echoed).toEqual({ kind: 'refused', code: 'PROVIDER_CREDENTIAL_ECHOED' });
  } finally {
    echoing = false;
  }
  expect(seen).toHaveLength(1);
  expect(custody.stderr().includes(tokens.hosting)).toBe(false);
});
