// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 egress, the address a listed name resolves to (security review S4).
//
// A destination is listed by origin, and a listed hostname can resolve to a
// cloud metadata or link-local address, first or on a later lookup (DNS
// rebinding). So the address is checked where the connection is made: the
// egress resolves the name once, refuses the call when any address is
// forbidden, and connects to the address it checked, never to a second
// lookup's. The literal forms of the same addresses are refused when the list
// is read.

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseDestinations,
  send,
  type Destination,
  type OutboundRequest,
  type Resolve,
} from '../../packages/core-custody/src/egress.ts';

let provider: ReplayProvider;

beforeAll(async () => {
  provider = await startReplayProvider();
});

afterAll(async () => {
  await provider.close();
});

const REQUEST: OutboundRequest = {
  destination: 'named',
  path: '/v1/complete',
  method: 'POST',
  body: '{"instruction":"draft","tone":"plain"}',
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
};

const listed = (origin: string): ReadonlyMap<string, Destination> =>
  new Map([['named', { key: 'named', origin }]]);

/** A resolver that answers from a table and counts its lookups. */
const table = (
  addresses: readonly string[],
): { readonly resolve: Resolve; readonly lookups: () => number } => {
  let lookups = 0;
  return {
    resolve: async () => {
      lookups += 1;
      return await Promise.resolve(
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    },
    lookups: () => lookups,
  };
};

/** Sockets this process opened while `run` ran. */
const socketsDuring = async <T>(
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly sockets: number }> => {
  let sockets = 0;
  const onSocket = (): void => {
    sockets += 1;
  };
  subscribe('net.client.socket', onSocket);
  try {
    return { result: await run(), sockets };
  } finally {
    unsubscribe('net.client.socket', onSocket);
  }
};

const FORBIDDEN_ANSWERS: readonly (readonly string[])[] = [
  ['169.254.169.254'],
  ['169.254.0.1'],
  ['::ffff:169.254.169.254'],
  ['::ffff:a9fe:a9fe'],
  ['fe80::1'],
  ['fd00:ec2::254'],
  ['0.0.0.0'],
  ['::'],
  // One forbidden address among allowed ones refuses the call: the connection
  // may take any of them.
  ['127.0.0.1', '169.254.169.254'],
  ['::1', 'fe80::1'],
  // A name that resolves to nothing is refused, not retried elsewhere.
  [],
];

it('AW-01 egress 11: a listed name resolving to a metadata or link-local address is refused before any connection', async () => {
  for (const addresses of FORBIDDEN_ANSWERS) {
    const { resolve } = table(addresses);
    const seen = provider.seen.length;
    // One at a time: each case counts the sockets opened while it alone runs.
    // eslint-disable-next-line no-await-in-loop
    const { result, sockets } = await socketsDuring(
      async () =>
        await send(
          listed('http://rebind.test'),
          REQUEST,
          { header: 'authorization', value: 'k' },
          resolve,
        ),
    );
    expect(result, addresses.join(' ')).toEqual({ ok: false, fault: 'forbidden', status: null });
    expect(sockets, addresses.join(' ')).toBe(0);
    expect(provider.seen.length).toBe(seen);
  }
});

it('AW-01 egress 12: the connection goes to the address the egress checked, from one lookup', async () => {
  const { resolve, lookups } = table(['127.0.0.1']);
  const port = new URL(provider.origin).port;
  const seen = provider.seen.length;
  // `replay.test` resolves nowhere on the system resolver: reaching the
  // stand-in proves the socket took the checked address, not a lookup of its own.
  const outcome = await send(listed(`http://replay.test:${port}`), REQUEST, null, resolve);
  expect(outcome.ok).toBe(true);
  expect(provider.seen.length).toBe(seen + 1);
  expect(lookups()).toBe(1);
});

it('AW-01 egress 13: without a resolver the system lookup is used, and still checked', async () => {
  const port = new URL(provider.origin).port;
  const outcome = await send(listed(`http://localhost:${port}`), REQUEST, null);
  expect(outcome.ok).toBe(true);
});

it('AW-01 egress 14: the literal forms of a forbidden address are refused when the list is read', () => {
  for (const origin of [
    'http://[::ffff:169.254.169.254]',
    'http://[::ffff:a9fe:a9fe]',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]',
    'http://2852039166',
    'http://0xa9fea9fe',
    'http://169.254.169.254.',
    'http://[::]',
    'http://[fe80:0:0:0:0:0:0:1]',
    'http://[FD00:EC2::254]',
  ]) {
    const parsed = parseDestinations([{ key: 'bad', origin }]);
    expect(parsed.ok ? 'accepted' : parsed.code, origin).toMatch(
      /DESTINATION_(FORBIDDEN|MALFORMED)/u,
    );
  }
  expect(parseDestinations([{ key: 'good', origin: 'http://127.0.0.1:8080' }]).ok).toBe(true);
});
