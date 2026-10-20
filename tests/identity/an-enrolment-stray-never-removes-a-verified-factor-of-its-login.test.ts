// SPDX-License-Identifier: AGPL-3.0-only
//
// An enrolment refused after the provider issued its factor lets that factor
// go, whether the record refused it or its answer was refused. Only the
// attempt's own unverified factor goes: an answer naming a factor the login
// holds verified, in the record or at the provider, removes nothing and
// holds nothing removed.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { enrolSecondFactor } from '../../packages/core-commands/src/commands/account-factor.ts';
import type {
  EnrolAnswer,
  FactorProvider,
} from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  factorDigest,
  loginRemovedFactors,
  loginVerifiedFactors,
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import {
  alpha,
  bravo,
  callerFor,
  db,
  namingProvider,
  openWorld,
  personIn,
  serverUrl,
} from './c59-factor-orphan-world.ts';

openWorld();

const PATHS = ['its record', 'its answer'] as const;
const WHERE = ['the record', 'the provider'] as const;

const answerFor = (path: (typeof PATHS)[number], factorId: string): EnrolAnswer =>
  path === 'its record'
    ? { ok: true, value: { factorId, qrCode: 'qr', secret: 's', uri: 'otpauth:' } }
    : { ok: false, fault: 'malformed', strayFactorId: factorId };

async function verifiedIn(business: string, personId: string, subject: string, id: string) {
  await db.app.withBusiness(business, async (tx) => {
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      subject,
      provider: 'supabase',
      providerFactorId: id,
    });
    await recordFactorVerified(tx, { personId, factorId: enrolled.id, subject });
  });
}

for (const path of PATHS) {
  for (const where of WHERE) {
    it.skipIf(serverUrl === undefined)(
      `an enrolment refused for ${path}, naming a factor ${where} holds verified for the login, removes nothing`,
      async () => {
        const subject = `sub-${randomUUID()}`;
        const alphaPerson = await personIn(alpha, subject);
        await personIn(bravo, subject);
        const verified = `factor-${randomUUID()}`;
        const { provider, asked } = namingProvider();
        const naming: FactorProvider = {
          ...provider,
          verifiedFactors: () =>
            Promise.resolve({ ok: true, value: where === 'the provider' ? [verified] : [] }),
          enrol: async () => {
            // The login verifies a factor in alpha while bravo's enrolment is at the provider.
            const inRecord = where === 'the record' ? verified : `factor-${randomUUID()}`;
            await verifiedIn(alpha, alphaPerson, subject, inRecord);
            return answerFor(path, verified);
          },
        };

        const refused = await enrolSecondFactor(callerFor(subject), naming);

        expect('code' in refused).toBe(true);
        expect(asked).not.toContain(`remove ${verified}`);
        const removed = await db.app.withBusiness(alpha, (tx) => loginRemovedFactors(tx, subject));
        expect(removed).not.toContain(factorDigest(verified));
        if (where === 'the record') {
          const held = await db.app.withBusiness(alpha, (tx) => loginVerifiedFactors(tx, subject));
          expect(held).toContain(factorDigest(verified));
        }
      },
    );
  }
}

it.skipIf(serverUrl === undefined)(
  'an enrolment whose answer was refused removes the unverified factor it names at the provider',
  async () => {
    const subject = `sub-${randomUUID()}`;
    await personIn(bravo, subject);
    const stray = `factor-${randomUUID()}`;
    const { provider, asked } = namingProvider();
    const naming: FactorProvider = {
      ...provider,
      enrol: () => Promise.resolve(answerFor('its answer', stray)),
    };

    const refused = await enrolSecondFactor(callerFor(subject), naming);

    expect('code' in refused ? refused.code : 'issued').toBe('PROVIDER_ANSWER_INVALID');
    expect(asked).toContain(`remove ${stray}`);
  },
);
