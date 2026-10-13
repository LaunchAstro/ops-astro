// SPDX-License-Identifier: AGPL-3.0-only
//
// C59, security review 2b2 round 11: a factor that lost under the lock is ended
// there, so a later verify cannot record it verified (r11-1); and a good code
// for a factor the record has since removed, or an issued factor the record
// refuses, is removed at the provider, once the record holds it removed.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  enrolSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  loginHasVerifiedFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
} from '../../packages/core-records/src/identity/second-factor.ts';
import {
  alpha,
  bravo,
  callerFor,
  db,
  enrolHere,
  events,
  factorIn,
  namingProvider,
  openWorld,
  personIn,
  serverUrl,
  statusOf,
} from './c59-factor-orphan-world.ts';

openWorld();

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: a factor that lost under the lock is ended there, so a later verify cannot record it verified (r11-1)', async () => {
      // Tab A's good code for F (alpha) loses to G, verified in bravo. Before
      // A's provider removal lands, Mia removes G and tab B verifies F.
      const subject = `sub-${randomUUID()}`;
      const alphaPerson = await personIn(alpha, subject);
      const bravoPerson = await personIn(bravo, subject);
      await db.app.withBusiness(alpha, (tx) =>
        recordFactorEnrolled(tx, {
          personId: alphaPerson,
          subject,
          provider: 'supabase',
          providerFactorId: `factor-${randomUUID()}`,
        }),
      );
      const inAlpha = (): FactorCaller => ({
        ...callerFor(subject),
        businessId: alpha,
        presented: { ...callerFor(subject).presented, sessionId: randomUUID() },
      });
      let g: { id: string } | undefined;
      // G is verified in bravo while tab A's code is at the provider.
      const racing = namingProvider(async () => {
        g = await factorIn(bravoPerson, subject, true);
      });
      let tabB = 'not run';
      const { provider } = namingProvider();
      const tabA: FactorProvider = {
        ...racing.provider,
        remove: async (token, factorId) => {
          await db.app.withBusiness(bravo, (tx) =>
            recordFactorRemoved(tx, { personId: bravoPerson, factorId: g?.id ?? '', subject }),
          );
          const answer = await verifySecondFactor(inAlpha(), { code: '123456' }, provider);
          tabB = 'code' in answer ? answer.code : 'verified';
          return await provider.remove(token, factorId);
        },
      };

      const answer = await verifySecondFactor(inAlpha(), { code: '123456' }, tabA);

      expect('code' in answer ? answer.code : 'verified').toBe('FACTOR_ALREADY_ENROLLED');
      expect(tabB).toBe('FACTOR_NOT_ENROLLED');
      const verifiedAnywhere = await db.app.withBusiness(alpha, (tx) =>
        loginHasVerifiedFactor(tx, subject),
      );
      expect(verifiedAnywhere).toBe(false);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: a good code refused because the factor was replaced meanwhile removes that factor at the provider, and reports no orphan', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const f = await factorIn(person, subject, false);
      const { provider, asked } = namingProvider(async () => {
        await db.app.withBusiness(bravo, async (tx) => {
          await recordFactorRemoved(tx, { personId: person, factorId: f.id, subject });
          await recordFactorEnrolled(tx, {
            personId: person,
            subject,
            provider: 'supabase',
            providerFactorId: `factor-${randomUUID()}`,
          });
        });
      });
      const before = (await events(bravo, 'account.factor_orphaned')).length;
      const caller = callerFor(subject);
      const tab = { ...caller, presented: { ...caller.presented, sessionId: randomUUID() } };

      const answer = await verifySecondFactor(tab, { code: '123456' }, provider);

      expect('code' in answer ? answer.code : 'verified').toBe('FACTOR_NOT_ENROLLED');
      expect(asked).toEqual(['verify', `remove ${f.providerFactorId}`]);
      expect((await events(bravo, 'account.factor_orphaned')).slice(before)).toEqual([]);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: an issued factor the record refuses as already enrolled is removed at the provider, and reports no orphan', async () => {
      const subject = `sub-${randomUUID()}`;
      const alphaPerson = await personIn(alpha, subject);
      const person = await personIn(bravo, subject);
      const { provider, asked } = namingProvider();
      const racing: FactorProvider = {
        ...provider,
        enrol: async (token) => {
          // Mia verifies a factor in alpha while bravo's enrolment is at the provider.
          await enrolHere(alpha, alphaPerson, subject, true);
          return await provider.enrol(token);
        },
      };
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const answer = await enrolSecondFactor(callerFor(subject), racing);

      expect('code' in answer ? answer.code : 'issued').toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['enrol', expect.stringMatching(/^remove factor-/u)]);
      expect(await statusOf(person)).toEqual([]);
      expect((await events(bravo, 'account.factor_orphaned')).slice(before)).toEqual([]);
    });
  },
);
