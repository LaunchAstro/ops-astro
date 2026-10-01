// SPDX-License-Identifier: AGPL-3.0-only
//
// C59, security review 2b2 rounds 7, 8 and 10: only a lost enrolment removes
// anything at the provider (`c59-factor-orphan.test.ts`). A step-up, a tab
// beaten by another, an enrolment racing a verify in another business and a
// refused removal each leave the provider's factor where it is.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  enrolSecondFactor,
  removeSecondFactor,
  verifySecondFactor,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { endOtherSeenSessions } from '../../packages/core-records/src/identity/sessions.ts';
import {
  alpha,
  bravo,
  callerFor,
  db,
  factorIn,
  namingProvider,
  openWorld,
  personIn,
  serverUrl,
  statusOf,
  stepUpAfterSignOut,
} from './c59-factor-orphan-world.ts';

openWorld();

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: a step-up with a good code refused because the session ended keeps the verified factor at the provider', async () => {
      const { code, asked, statuses } = await stepUpAfterSignOut();

      expect(code).toBe('AUTH_SESSION_EXPIRED');
      expect(asked).toEqual(['verify']);
      expect(statuses).toEqual([{ status: 'verified' }]);
    });

    it('C59: two tabs completing one enrolment, the winner ending the loser, leave the factor verified at the provider', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const factor = await factorIn(person, subject, false);
      // Tab B's completion commits while tab A's good code is at the provider.
      const { provider, asked } = namingProvider(async () => {
        await db.app.withBusiness(bravo, async (tx) => {
          await recordFactorVerified(tx, { personId: person, factorId: factor.id, subject });
          await endOtherSeenSessions(tx, person, randomUUID(), 'factor_change', subject);
        });
      });
      const caller = callerFor(subject);
      const tabA = { ...caller, presented: { ...caller.presented, sessionId: randomUUID() } };

      const answer = await verifySecondFactor(tabA, { code: '123456' }, provider);

      expect('code' in answer ? answer.code : 'verified').toBe('AUTH_SESSION_EXPIRED');
      expect(asked).toEqual(['verify']);
      expect(await statusOf(person)).toEqual([{ status: 'verified' }]);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: a concurrent first verify in another business keeps its factor at the provider', async () => {
      // Security review 2b2 round 10: Mia's good code for F, enrolled in alpha,
      // is through at the provider but not yet recorded while she enrols in
      // bravo; alpha then records F verified. Bravo removes nothing there.
      const subject = `sub-${randomUUID()}`;
      const alphaPerson = await personIn(alpha, subject);
      const f = await db.app.withBusiness(alpha, (tx) =>
        recordFactorEnrolled(tx, {
          personId: alphaPerson,
          provider: 'supabase',
          providerFactorId: `factor-${randomUUID()}`,
        }),
      );
      const person = await personIn(bravo, subject);
      // The provider holds F, verified there, the whole time.
      const { provider, asked } = namingProvider();

      const answer = await enrolSecondFactor(callerFor(subject), provider);
      await db.app.withBusiness(alpha, (tx) =>
        recordFactorVerified(tx, { personId: alphaPerson, factorId: f.id, subject }),
      );

      expect('code' in answer ? answer.code : 'issued').toBe('issued');
      expect(asked.filter((call) => call.startsWith('remove'))).toEqual([]);
      expect(await statusOf(person)).toEqual([{ status: 'unverified' }]);
    });

    it('C59: a removal the product refuses removes nothing at the provider', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      await factorIn(person, subject, true);
      // Signed out in another tab while this one held the code.
      const { provider, asked } = namingProvider(async () => {
        await db.app.withBusiness(bravo, (tx) =>
          endOtherSeenSessions(tx, person, randomUUID(), 'factor_change', subject),
        );
      });
      const caller = callerFor(subject);
      const tab = { ...caller, presented: { ...caller.presented, sessionId: randomUUID() } };

      const answer = await removeSecondFactor(tab, { code: '123456' }, provider);

      expect('code' in answer ? answer.code : 'removed').toBe('AUTH_SESSION_EXPIRED');
      expect(asked.filter((call) => call.startsWith('remove'))).toEqual([]);
      expect(await statusOf(person)).toEqual([{ status: 'verified' }]);
    });
  },
);
