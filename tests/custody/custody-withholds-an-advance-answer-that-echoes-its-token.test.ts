// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody alone, no connector code: an answer to the branch advance that plants
// the token in `object.sha`, in `ref`, or half in each is withheld as echoed,
// and the token never comes back. A clean answer comes back cut to those two
// fields. Removing the joined reading from custody's `withholds` turns the split
// proof red.

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
  type CustodyOutcome,
  type Destination,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';

const token = `canary-${randomBytes(18).toString('hex')}`;
const REF_PATH = '/repos/agency/site/git/refs/heads/main';

/** The source entry's advance route, in the agreed shape, the only route custody holds here. */
const ADVANCE_ROUTE = {
  method: 'PATCH' as string,
  template: '/repos/{repository}/{repository}/git/refs/heads/{branch}',
  fields: { 'object.sha': 'string', ref: 'string' },
  body: ['sha'],
} as const;

const sourceOf = (origin: string): Destination =>
  ({
    key: 'source_control',
    origin,
    headers: { accept: 'application/json', 'user-agent': 'site-connector' },
    routes: [ADVANCE_ROUTE],
    post: false,
  }) as Destination;

let answer: unknown = {};
let server: Server;
let folder: string;
let custody: Custody | undefined;
let notStarted: string | undefined;
const seen: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'advance-echo-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'source_control',
        kind: 'api_key',
        account: 'source_control-1',
        destination: 'source_control',
        header: 'authorization',
        value: token,
      },
    ]),
    { mode: 0o600 },
  );
  const destinations = [sourceOf(origin)];
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

/** The advance as custody receives it, answered with `body` by the stand-in. */
async function advanceAnswered(body: unknown): Promise<CustodyOutcome> {
  expect(notStarted).toBeUndefined();
  answer = body;
  return await custody!.dispatch('source_control', {
    destination: 'source_control',
    path: REF_PATH,
    method: 'PATCH' as string,
    body: JSON.stringify({ sha: 'c0ffee01' }),
    timeoutMs: 5_000,
    maxResponseBytes: 65_536,
  } as OutboundRequest);
}

it('a clean advance answer comes back cut to its object.sha and ref', async () => {
  seen.length = 0;
  const outcome = await advanceAnswered({
    ref: 'refs/heads/main',
    url: 'https://api.github.com/repos/agency/site/git/refs/heads/main',
    object: { sha: 'c0ffee01', type: 'commit' },
  });
  expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: true, status: 200 } });
  const body = outcome.kind === 'answered' && outcome.outbound.ok ? outcome.outbound.body : '';
  expect(JSON.parse(body)).toEqual({ object: { sha: 'c0ffee01' }, ref: 'refs/heads/main' });
  expect(seen).toEqual([`PATCH ${REF_PATH}`]);
});

it('an advance answer with the token in object.sha is withheld as echoed', async () => {
  const outcome = await advanceAnswered({ ref: 'refs/heads/main', object: { sha: token } });
  expect(outcome).toEqual({ kind: 'withheld', started: true, reason: 'echoed' });
  expect(JSON.stringify(outcome).includes(token)).toBe(false);
});

it('an advance answer with the token in ref is withheld as echoed', async () => {
  const outcome = await advanceAnswered({
    ref: `refs/heads/${token}`,
    object: { sha: 'c0ffee01' },
  });
  expect(outcome).toEqual({ kind: 'withheld', started: true, reason: 'echoed' });
  expect(JSON.stringify(outcome).includes(token)).toBe(false);
});

it('an advance answer with the token split across object.sha and ref is withheld as echoed', async () => {
  const half = Math.floor(token.length / 2);
  const outcomes = [
    await advanceAnswered({ object: { sha: token.slice(0, half) }, ref: token.slice(half) }),
    await advanceAnswered({ ref: token.slice(0, half), object: { sha: token.slice(half) } }),
  ];
  expect(outcomes).toEqual([
    { kind: 'withheld', started: true, reason: 'echoed' },
    { kind: 'withheld', started: true, reason: 'echoed' },
  ]);
  expect(JSON.stringify(outcomes).includes(token)).toBe(false);
  expect(custody?.stderr().includes(token)).toBe(false);
});
