// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's fixed route templates: a destination may list a call's exact
// shape, query included, and custody sends only a request that fills it. No
// other path, no extra or missing query parameter, no free query string.
// Custody adds the destination's credential itself, and passes back only the
// fields each route declares. A local stand-in answers
// in place of any provider.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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

const LOOKUP = '/v6/deployments?projectId={project}&sha={sha}&target=production&limit=1';
const READ = '/v13/deployments/{deployment}';
const FIELDS = { 'deployments.0.uid': 'string' };
const canary = `canary-${randomBytes(18).toString('hex')}`;
const seen: { method: string; url: string; authorization: string | undefined }[] = [];
let server: Server;
let custody: Custody;
let folder: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
      });
      const content = 'PHA+';
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ deployments: [{ uid: 'dpl_1' }], content }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'custody-templates-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'hosting',
        kind: 'api_key',
        account: 'hosting-1',
        destination: 'hosting',
        header: 'authorization',
        value: canary,
      },
    ]),
    { mode: 0o600 },
  );
  const hosting = {
    key: 'hosting',
    origin,
    post: false,
    routes: [
      { method: 'GET', template: LOOKUP, fields: FIELDS },
      { method: 'GET', template: READ, fields: { content: 'string' } },
    ],
  } as unknown as Destination;
  custody = await startCustody({ credentialsFile, destinations: [hosting] });
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

const dispatch = async (method: string, path: string) =>
  await custody.dispatch('hosting', {
    destination: 'hosting',
    path,
    method,
    body: '',
    timeoutMs: 2_000,
    maxResponseBytes: 4_096,
  } as never);

const FILLED = '/v6/deployments?projectId=prj_abc&sha=c0ffee&target=production&limit=1';

it('a request filling a listed template, query included, is sent with the credential custody adds', async () => {
  seen.length = 0;
  const outcome = await dispatch('GET', FILLED);
  expect(outcome).toMatchObject({
    kind: 'answered',
    outbound: {
      ok: true,
      status: 200,
      body: JSON.stringify({ deployments: { 0: { uid: 'dpl_1' } } }),
    },
  });
  expect(await dispatch('GET', '/v13/deployments/dpl_1')).toMatchObject({
    outbound: { ok: true },
  });
  expect(seen.map((one) => [one.method, one.url])).toEqual([
    ['GET', FILLED],
    ['GET', '/v13/deployments/dpl_1'],
  ]);
  expect(seen.every((one) => one.authorization === `Bearer ${canary}`)).toBe(true);
  expect(JSON.stringify(outcome).includes(canary)).toBe(false);
});

it('a path off the list, an extra, missing or altered query parameter, or a free query is refused before a socket', async () => {
  seen.length = 0;
  const refused = [
    '/v6/deployments',
    '/v9/projects/prj_abc',
    '/v13/deployments/dpl_1/events',
    '/v13/deployments/dpl_1?withGitRepoInfo=true',
    `${FILLED}&teamId=team_1`,
    '/v6/deployments?projectId=prj_abc&sha=c0ffee&target=production',
    '/v6/deployments?sha=c0ffee&projectId=prj_abc&target=production&limit=1',
    '/v6/deployments?projectId=prj_abc&sha=c0ffee&target=preview&limit=1',
    '/v6/deployments?projectId=prj_abc&sha=c0ffee&target=production&limit=100',
    '/v6/deployments?projectId=prj%2fabc&sha=c0ffee&target=production&limit=1',
    '/v6/deployments?projectId=a&b=c&sha=c0ffee&target=production&limit=1',
    '/v6/deployments?projectId=&sha=c0ffee&target=production&limit=1',
    '/v6/deployments?q',
    '/v13/deployments/..',
  ];
  for (const path of refused) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await dispatch('GET', path);
    expect(outcome, path).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'bad_path' },
    });
  }
  // No POST beside the listed routes, and no POST or PUT on a GET's template.
  for (const method of ['POST', 'PUT']) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await dispatch(method, FILLED);
    expect(outcome, method).toMatchObject({ kind: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' });
  }
  expect(seen).toEqual([]);
});

it('a malformed template is refused at load', () => {
  const origin = 'https://api.example.com';
  const load = (extra: Record<string, unknown>) =>
    parseDestinations([{ key: 'hosting', origin, ...extra }]);
  expect(load({ routes: [{ method: 'GET', template: LOOKUP, fields: FIELDS }] })).toMatchObject({
    ok: true,
  });
  const route = (method: string, template: string, more: Record<string, unknown> = {}) => ({
    routes: [{ method, template, fields: FIELDS, ...more }],
  });
  const refused: Record<string, unknown>[] = [
    route('GET', '/v6/deployments?{query}'),
    route('GET', '/v6/deployments?projectId={project*}'),
    route('GET', '/v6/{a}/../x'),
    route('GET', 'v6/deployments'),
    route('GET', '//evil.example.com/x'),
    route('GET', '/v6/deployments?a=1&&b=2'),
    route('DELETE', '/v6/deployments'),
    route('PATCH', '/v6/deployments'),
    route('GET', '/v6/deployments', { path: '/v6/deployments' }),
  ];
  for (const extra of refused) {
    expect(load(extra), JSON.stringify(extra)).toMatchObject({
      ok: false,
      code: 'DESTINATION_MALFORMED',
    });
  }
});
