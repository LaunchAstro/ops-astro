// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.handback` and the successor it may ask for.
//
// The successor's caller-supplied half is `purpose`, `maximumMinor`,
// `currency`, `payload`, `step` and `expiresInSeconds`. `proposedByActorId` is not in
// it and never can be: L4's `writeProposal` records the version as coming from
// whoever that field names, so a body that could fill it would be a body
// choosing whose authority the successor is recorded under -- the same claim
// `pickupReservation` refuses to let a body make about `authorisedByPersonId`.
// It is the agent actor of the session, handed to the command by the agent
// entry point, and a body carrying it is refused the way every other
// server-owned field is: `FIELD_NOT_WRITABLE`, naming the key.
//
// Like `handback-expenditure.test.ts` beside it, these are payload guards and
// answer before the database is reached, so this suite moves the database
// counter by zero: it is a pure unit suite and must not be named in
// `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import { handbackLease } from '../../packages/core-records/src/commands/tasks-handback.ts';
import { readSuccessor } from '../../packages/core-records/src/commands/successor.ts';
import { isRefused } from '../../packages/core-records/src/commands/outcome.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

/** A transaction that fails the test if it is touched. */
const untouched = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`handback reached the database at .${String(property)}`);
    },
  },
) as unknown as TenantQuery;

const ordinary = {
  leaseId: '3f1d2f3a-0000-4000-8000-000000000001',
  fence: 1,
  outcome: 'completed',
};

const AGENT = '3f1d2f3a-0000-4000-8000-0000000000a9';

const wellFormed = {
  purpose: 'draft_the_reply',
  maximumMinor: 2_500,
  currency: 'AUD',
  payload: { instruction: 'try again with the client note' },
  step: { kind: 'compose', payload: { tone: 'plain' } },
};

describe('task.handback and the successor proposal', () => {
  it.each(['proposedByActorId', 'proposed_by_actor_id'])(
    'refuses a body naming %s rather than recording the actor it names',
    async (field) => {
      const outcome = await handbackLease(
        untouched,
        { ...ordinary, successor: { ...wellFormed, [field]: AGENT } },
        AGENT,
      );

      expect(isRefused(outcome)).toBe(true);
      if (!isRefused(outcome)) throw new Error('unreachable');
      expect(outcome.refusal.code).toBe('FIELD_NOT_WRITABLE');
      expect(outcome.refusal.names).toEqual([`successor.${field}`]);
      // The attempted value goes to the audit event and never to the response.
      expect(outcome.attempted).toEqual({ [`successor.${field}`]: AGENT });
    },
  );

  it('refuses a successor that is not an object', async () => {
    const outcome = await handbackLease(untouched, { ...ordinary, successor: 'yes please' }, AGENT);
    expect(isRefused(outcome)).toBe(true);
    if (!isRefused(outcome)) throw new Error('unreachable');
    expect(outcome.refusal.code).toBe('FIELD_VALUE_INVALID');
    expect(outcome.refusal.names).toEqual(['successor']);
  });

  it.each([
    ['purpose', { purpose: 42 }],
    ['maximumMinor', { maximumMinor: 'a lot' }],
    ['currency', { currency: null }],
    ['payload', { payload: 'not an object' }],
    ['step', { step: { kind: 7, payload: {} } }],
    ['expiresInSeconds', { expiresInSeconds: 'a week' }],
    ['expiresInSeconds', { expiresInSeconds: 0 }],
    ['expiresInSeconds', { expiresInSeconds: -60 }],
    ['expiresInSeconds', { expiresInSeconds: 1.5 }],
    // The absolute spelling the successor used to take. A caller still sending
    // it is told so by name rather than handed the default week in silence.
    ['expiresAt', { expiresAt: '2099-01-01T00:00:00Z' }],
  ])('refuses a successor whose %s is not what it has to be', async (name, broken) => {
    const outcome = await handbackLease(
      untouched,
      { ...ordinary, successor: { ...wellFormed, ...broken } },
      AGENT,
    );
    expect(isRefused(outcome)).toBe(true);
    if (!isRefused(outcome)) throw new Error('unreachable');
    expect(outcome.refusal.code).toBe('FIELD_VALUE_INVALID');
    expect(outcome.refusal.names).toEqual([`successor.${name}`]);
  });

  // The successor's expiry is a duration the server adds to its own clock, as
  // `task.propose`'s is, so a caller cannot hold a ceiling open to an instant
  // of its choosing.
  it('turns expiresInSeconds into an instant on the server clock', () => {
    const before = Date.now();
    const read = readSuccessor({ ...wellFormed, expiresInSeconds: 90 }, AGENT);
    const after = Date.now();
    if (!('successor' in read)) throw new Error('refused a well-formed successor');
    const at = read.successor.expiresAt.getTime();
    expect(at).toBeGreaterThanOrEqual(before + 90_000);
    expect(at).toBeLessThanOrEqual(after + 90_000);
  });

  it('gives a successor with no expiry the week propose gives', () => {
    const before = Date.now();
    const read = readSuccessor({ ...wellFormed }, AGENT);
    if (!('successor' in read)) throw new Error('refused a well-formed successor');
    expect(read.successor.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 7 * 24 * 60 * 60 * 1000,
    );
  });

  it('lets a well-formed successor through to the runtime', async () => {
    // It reaches the database, which is exactly what the proxy reports: no
    // payload guard fired. Anything past this point is L4's handback.
    await expect(
      handbackLease(untouched, { ...ordinary, successor: { ...wellFormed } }, AGENT),
    ).rejects.toThrow(/reached the database/u);
  });

  it('is still the ordinary handback when no successor is asked for', async () => {
    await expect(handbackLease(untouched, { ...ordinary }, AGENT)).rejects.toThrow(
      /reached the database/u,
    );
  });
});
