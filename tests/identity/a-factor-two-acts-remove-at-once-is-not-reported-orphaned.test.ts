// SPDX-License-Identifier: AGPL-3.0-only
//
// Two acts of one login, each on its own connection, can both decide a
// factor goes at the provider: a removal the record committed, and a good
// code whose record step found that factor removed meanwhile; or two good
// codes whose catch-ups both list the same factor held removed. The provider
// removes it once and refuses the second ask, as GoTrue answers a DELETE for
// a factor it no longer holds. A factor the provider no longer holds is not
// an orphan, so neither act reports one.

import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { recordStrayRemoved } from '../../packages/core-records/src/identity/second-factor.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  bravo,
  callerFor,
  db,
  events,
  factorIn,
  openWorld,
  personIn,
  serverUrl,
} from './c59-factor-orphan-world.ts';

openWorld();

const opened: Database[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((database) => database.close()));
});

/** A caller of the login on a connection of its own, in its own tab. */
function tab(subject: string): FactorCaller {
  const database = connect(db.appUrl);
  opened.push(database);
  return {
    ...callerFor(subject),
    database,
    presented: { ...callerFor(subject).presented, sessionId: randomUUID() },
  };
}

/** GoTrue as it answers: a factor it holds is removed once; asked again, it refuses. */
function goTrue(held: string[], hooks: Partial<FactorProvider> = {}): FactorProvider {
  const session = { accessToken: 'aal2', refreshToken: 'r', expiresIn: 3600 };
  return {
    verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
    heldFactors: () => Promise.resolve({ ok: true, value: [...held] }),
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: () => Promise.resolve({ ok: true, value: session }),
    remove: (_token, factorId) => {
      if (!held.includes(factorId)) return Promise.resolve({ ok: false, fault: 'refused' });
      held.splice(held.indexOf(factorId), 1);
      return Promise.resolve({ ok: true, value: undefined });
    },
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
    ...hooks,
  };
}

it.skipIf(serverUrl === undefined)(
  'a factor removed in one tab while another tab proves a code for it is removed once and reported orphaned by neither',
  async () => {
    const subject = `sub-${randomUUID()}`;
    const person = await personIn(bravo, subject);
    const factor = await factorIn(person, subject, true);
    const held = [factor.providerFactorId];
    const before = (await events(bravo, 'account.factor_orphaned')).length;
    const plain = goTrue(held);
    let removal: unknown;
    // The second tab's code is at the provider when the first tab removes the factor.
    const racing = goTrue(held, {
      verify: async (token, factorId, code) => {
        removal = await removeSecondFactor(tab(subject), { code: '123456' }, plain);
        return await plain.verify(token, factorId, code);
      },
    });

    const stepUp = await verifySecondFactor(tab(subject), { code: '123456' }, racing);

    expect({
      removal,
      stepUp: 'code' in stepUp ? stepUp.code : 'verified',
      held,
      orphaned: (await events(bravo, 'account.factor_orphaned')).slice(before),
    }).toEqual({
      removal: expect.objectContaining({ removed: true }),
      stepUp: expect.any(String),
      held: [],
      orphaned: [],
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'two good codes at once whose catch-ups both find one factor held removed remove it once and report no orphan',
  async () => {
    const subject = `sub-${randomUUID()}`;
    const person = await personIn(bravo, subject);
    await factorIn(person, subject, true);
    // A factor issued to an enrolment the record refused, held removed for the login.
    const stray = `factor-${randomUUID()}`;
    await db.app.withBusiness(bravo, (tx) =>
      recordStrayRemoved(tx, { subject, providerFactorId: stray }),
    );
    const held = [stray];
    const before = (await events(bravo, 'account.factor_orphaned')).length;
    const plain = goTrue(held);
    let other: unknown;
    // The second tab's whole step-up runs between the first's listing and its removal.
    const racing = goTrue(held, {
      heldFactors: async (token) => {
        const listed = await plain.heldFactors(token);
        other = await verifySecondFactor(tab(subject), { code: '123456' }, plain);
        return listed;
      },
    });

    const first = await verifySecondFactor(tab(subject), { code: '123456' }, racing);

    expect({
      first: 'code' in first ? first.code : 'verified',
      other:
        other !== null && typeof other === 'object' && 'code' in other ? other.code : 'verified',
      held,
      orphaned: (await events(bravo, 'account.factor_orphaned')).slice(before),
    }).toEqual({ first: 'verified', other: 'verified', held: [], orphaned: [] });
  },
);

it.skipIf(serverUrl === undefined)(
  'a removal the provider made but whose answer was lost, asked again, reports no orphan',
  async () => {
    const subject = `sub-${randomUUID()}`;
    const person = await personIn(bravo, subject);
    const factor = await factorIn(person, subject, true);
    const held = [factor.providerFactorId];
    const before = (await events(bravo, 'account.factor_orphaned')).length;
    const plain = goTrue(held);
    let lost = false;
    // The first DELETE lands at the provider; its answer never comes back.
    const lossy = goTrue(held, {
      remove: async (token, factorId) => {
        const answer = await plain.remove(token, factorId);
        if (lost) return answer;
        lost = true;
        return { ok: false, fault: 'slow' };
      },
    });

    const removal = await removeSecondFactor(tab(subject), { code: '123456' }, lossy);

    expect({
      removal,
      held,
      orphaned: (await events(bravo, 'account.factor_orphaned')).slice(before),
    }).toEqual({ removal: expect.objectContaining({ removed: true }), held: [], orphaned: [] });
  },
);
