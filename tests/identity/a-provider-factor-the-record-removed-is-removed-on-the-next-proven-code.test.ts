// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor the record holds removed for a login, which the provider would not
// remove when asked, is removed on that login's next code the provider
// proves, in any business the login reaches. Only a factor the login's own
// record holds removed goes: one the record never decided on, or one another
// login's record removed, stays.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  enrolSecondFactor,
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  alpha,
  bravo,
  callerFor,
  db,
  enrolHere,
  factorIn,
  namingProvider,
  openWorld,
  personIn,
  serverUrl,
} from './c59-factor-orphan-world.ts';
import { recordFactorRemoved } from '../../packages/core-records/src/identity/second-factor.ts';

openWorld();

/** The provider, holding `held` for the login, whose removals fail until `working` is set. */
function stubbornProvider(held: string[]) {
  const { provider, asked } = namingProvider();
  const state = { working: false };
  const stubborn: FactorProvider = {
    ...provider,
    heldFactors: () => Promise.resolve({ ok: true, value: [...held] }),
    enrol: async (token) => {
      const issued = await provider.enrol(token);
      if (issued.ok) held.push(issued.value.factorId);
      return issued;
    },
    remove: async (token, factorId) => {
      const answer = await provider.remove(token, factorId);
      if (!state.working) return { ok: false, fault: 'unreachable' };
      held.splice(held.indexOf(factorId), 1);
      return answer;
    },
  };
  return { provider: stubborn, asked, state };
}

const inBusiness = (subject: string, businessId: string): FactorCaller => ({
  ...callerFor(subject),
  businessId,
  presented: { ...callerFor(subject).presented, sessionId: randomUUID() },
});

describe.skipIf(serverUrl === undefined)(
  'a provider factor the record removed is removed on the next proven code',
  () => {
    it('an issued factor the record refused, which the provider would not remove, is removed on the next good code in another business', async () => {
      const subject = `sub-${randomUUID()}`;
      const alphaPerson = await personIn(alpha, subject);
      await personIn(bravo, subject);
      const held: string[] = [];
      const { provider, asked, state } = stubbornProvider(held);
      const racing: FactorProvider = {
        ...provider,
        enrol: async (token) => {
          // Mia verifies a factor in alpha while bravo's enrolment is at the provider.
          await enrolHere(alpha, alphaPerson, subject, true);
          return await provider.enrol(token);
        },
      };
      const refused = await enrolSecondFactor(callerFor(subject), racing);
      expect('code' in refused ? refused.code : 'issued').toBe('FACTOR_ALREADY_ENROLLED');
      const stray = held[0] ?? '';
      expect(asked.filter((call) => call === `remove ${stray}`)).toHaveLength(2);
      state.working = true;

      // Her next good code, a step-up in alpha against the factor she verified there.
      const stepUp = await verifySecondFactor(
        inBusiness(subject, alpha),
        { code: '123456' },
        provider,
      );

      expect('code' in stepUp ? stepUp.code : 'verified').toBe('verified');
      expect(held).not.toContain(stray);
    });

    it('a removed factor the provider would not remove is removed on the next good code', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const old = await factorIn(person, subject, true);
      const held = [old.providerFactorId];
      const { provider, state } = stubbornProvider(held);

      const removed = await removeSecondFactor(callerFor(subject), { code: '123456' }, provider);
      expect('code' in removed ? removed.code : 'removed').toBe('removed');
      expect(held).toContain(old.providerFactorId);
      state.working = true;
      // A new authenticator, and the good code that completes it.
      const issued = await enrolSecondFactor(callerFor(subject), provider);
      expect('code' in issued ? issued.code : 'issued').toBe('issued');
      const done = await verifySecondFactor(
        inBusiness(subject, bravo),
        { code: '123456' },
        provider,
      );

      expect('code' in done ? done.code : 'verified').toBe('verified');
      expect(held).not.toContain(old.providerFactorId);
    });

    it('a good code removes no provider factor the login record never decided on, nor one another login removed', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      await factorIn(person, subject, true);
      // Another login, of another person here, whose factor its own record removed.
      const otherSubject = `sub-${randomUUID()}`;
      const other = await personIn(bravo, otherSubject);
      const theirs = await factorIn(other, otherSubject, true);
      await db.app.withBusiness(bravo, (tx) =>
        recordFactorRemoved(tx, { personId: other, factorId: theirs.id, subject: otherSubject }),
      );
      const undecided = `factor-${randomUUID()}`;
      const held = [undecided, theirs.providerFactorId];
      const { provider, asked, state } = stubbornProvider(held);
      state.working = true;

      const stepUp = await verifySecondFactor(callerFor(subject), { code: '123456' }, provider);

      expect('code' in stepUp ? stepUp.code : 'verified').toBe('verified');
      expect(asked.filter((call) => call.startsWith('remove'))).toEqual([]);
    });
  },
);
