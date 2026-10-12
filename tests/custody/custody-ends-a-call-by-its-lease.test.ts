// SPDX-License-Identifier: AGPL-3.0-only
//
// A dispatch may name `notAfter`, the epoch ms its caller's lease lets the call
// run to. Custody's own process sends nothing once it has passed, so a call that
// waited anywhere on its way out never starts after its lease, and it cuts the
// call's own timeout to it, so none is still running then.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { openCustodyWorld, type CustodyWorld } from './custody-world.ts';

let world: CustodyWorld;

beforeAll(async () => {
  world = await openCustodyWorld();
});

afterAll(async () => {
  await world?.close();
});

it('a call that reaches custody after its lease is refused and reaches no provider', async () => {
  world.provider.mode('answer');
  const before = world.provider.seen.length;
  const outcome = await world.custody.dispatch(
    'replay_key',
    world.request({ notAfter: Date.now() - 1 }),
  );
  expect({ outcome, sent: world.provider.seen.length - before }).toEqual({
    outcome: { kind: 'refused', started: false, code: 'CUSTODY_PAST_LEASE' },
    sent: 0,
  });
});

it('a call whose lease ends before its timeout is cut at the lease', async () => {
  world.provider.mode('slow');
  const started = Date.now();
  const outcome = await world.custody.dispatch(
    'replay_key',
    world.request({ timeoutMs: 9_000, notAfter: started + 500 }),
  );
  expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: false, fault: 'timeout' } });
  expect(Date.now() - started).toBeLessThan(3_000);
});

it('a call inside its lease is sent and answered', async () => {
  world.provider.mode('answer');
  const outcome = await world.custody.dispatch(
    'replay_key',
    world.request({ notAfter: Date.now() + 60_000 }),
  );
  expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: true } });
});

it.each([
  ['text', '1'],
  ['not a number', Number.NaN],
  ['null', null],
])('a lease end given as %s is refused as malformed', async (_case, notAfter) => {
  const outcome = await world.custody.dispatch(
    'replay_key',
    world.request({ notAfter: notAfter as number }),
  );
  expect(outcome).toEqual({ kind: 'refused', started: false, code: 'CUSTODY_REQUEST_MALFORMED' });
});
