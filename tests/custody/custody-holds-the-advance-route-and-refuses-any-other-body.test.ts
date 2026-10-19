// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody holds the source entry's one PATCH, the branch advance, as a fixed
// template whose body is one JSON object of a string `sha` and nothing else.
// That advance reaches the provider once with the token custody adds; any other
// body, ref, method or destination is refused before a socket opens. Dropping
// custody's PATCH body check turns the body proof red.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  parseDestinations,
  siteDestination,
  startCustody,
  type Custody,
  type CustodyOutcome,
  type Destination,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';

const tokens = {
  source_control: `canary-${randomBytes(18).toString('hex')}`,
  hosting: `canary-${randomBytes(18).toString('hex')}`,
};
const REF_PATH = '/repos/agency/site/git/refs/heads/main';
const ADVANCE = JSON.stringify({ sha: 'c0ffee01' });

/** The advance route as the agreed interface writes it: template, kept fields and body names. */
const ADVANCE_ROUTE = {
  method: 'PATCH' as string,
  template: '/repos/{repository}/{repository}/git/refs/heads/{branch}',
  fields: { 'object.sha': 'string', ref: 'string' },
  body: ['sha'],
} as const;

/** The source entry built by hand in the agreed shape, so custody's own load is what is proved. */
const sourceOf = (origin: string): Destination =>
  ({
    key: 'source_control',
    origin,
    headers: { accept: 'application/json', 'user-agent': 'site-connector' },
    routes: [ADVANCE_ROUTE],
    post: false,
  }) as Destination;

const seen: { method: string; url: string; authorization: string | undefined; body: string }[] = [];
let server: Server;
let folder: string;
let custody: Custody | undefined;
let notStarted: string | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ref: 'refs/heads/main', object: { sha: 'c0ffee01' } }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'advance-route-'));
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
  const destinations = [sourceOf(origin), siteDestination('hosting', origin)];
  try {
    custody = await startCustody({ credentialsFile, destinations });
  } catch (error) {
    // Custody's own load of the same list says why it stopped.
    notStarted = `${String(error)}: ${JSON.stringify(parseDestinations(destinations))}`;
  }
}, 60_000);

afterAll(async () => {
  await custody?.stop();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

/** Custody as started with the advance route, or the reason it refused to start. */
function started(): Custody {
  expect(notStarted).toBeUndefined();
  return custody!;
}

/** One request to custody by reference: the method is any the caller might name. */
const dispatch = async (
  ref: 'source_control' | 'hosting',
  method: string,
  path: string,
  body: string,
): Promise<CustodyOutcome> =>
  await started().dispatch(ref, {
    destination: ref,
    path,
    method,
    body,
    timeoutMs: 5_000,
    maxResponseBytes: 65_536,
  } as OutboundRequest);

/** Refused before any socket: custody's refusal, or its `bad_path` fault. */
const refusedBeforeSocket = (outcome: CustodyOutcome): boolean =>
  outcome.kind === 'refused' ||
  (outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.fault === 'bad_path');

it('the source entry lists the advance as a PATCH template with its body names, and custody loads it', () => {
  const listed = siteDestination('source_control', 'https://api.github.com').routes ?? [];
  const advance = listed.find(
    (route) => route.method === ADVANCE_ROUTE.method && 'template' in route,
  );
  expect(advance).toEqual(ADVANCE_ROUTE);
  expect(parseDestinations([sourceOf('https://api.github.com')])).toMatchObject({ ok: true });
  // A PATCH is only ever a template: an exact path for it is no route.
  const asPath = {
    ...sourceOf('https://api.github.com'),
    routes: [{ method: 'PATCH', path: REF_PATH }],
  };
  expect(parseDestinations([asPath])).toMatchObject({ ok: false, code: 'DESTINATION_MALFORMED' });
});

it('an advance of one string sha reaches the provider once, with the token custody adds', async () => {
  seen.length = 0;
  const outcome = await dispatch('source_control', 'PATCH', REF_PATH, ADVANCE);
  expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: true, status: 200 } });
  expect(seen).toEqual([
    {
      method: 'PATCH',
      url: REF_PATH,
      authorization: `Bearer ${tokens.source_control}`,
      body: ADVANCE,
    },
  ]);
});

it('an advance body that is not one object of a string sha alone is refused before a socket', async () => {
  seen.length = 0;
  const bodies = {
    force: JSON.stringify({ sha: 'c0ffee01', force: true }),
    extra: JSON.stringify({ sha: 'c0ffee01', note: 'x' }),
    list: JSON.stringify(['c0ffee01']),
    text: JSON.stringify('c0ffee01'),
    numberSha: JSON.stringify({ sha: 12_345 }),
    empty: '',
  };
  const outcomes: Record<string, unknown> = {};
  for (const [name, body] of Object.entries(bodies)) {
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await dispatch('source_control', 'PATCH', REF_PATH, body);
    outcomes[name] = outcome.kind === 'answered' ? outcome.outbound : outcome;
  }
  const badPath = { ok: false, fault: 'bad_path', status: null };
  expect(outcomes).toEqual(Object.fromEntries(Object.keys(bodies).map((name) => [name, badPath])));
  expect(seen).toEqual([]);
});

it('a PATCH off the advance route, or another method on it, is refused before a socket', async () => {
  seen.length = 0;
  const asked = {
    tag: await dispatch('source_control', 'PATCH', '/repos/agency/site/git/refs/tags/v1', ADVANCE),
    deeper: await dispatch('source_control', 'PATCH', `${REF_PATH}/x`, ADVANCE),
    hosting: await dispatch('hosting', 'PATCH', REF_PATH, ADVANCE),
    post: await dispatch('source_control', 'POST', REF_PATH, ADVANCE),
    put: await dispatch('source_control', 'PUT', REF_PATH, ADVANCE),
  };
  const refused = Object.fromEntries(
    Object.entries(asked).map(([name, outcome]) => [name, refusedBeforeSocket(outcome)]),
  );
  expect(refused).toEqual({ tag: true, deeper: true, hosting: true, post: true, put: true });
  expect(seen).toEqual([]);
});
