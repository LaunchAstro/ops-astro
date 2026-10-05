// SPDX-License-Identifier: AGPL-3.0-only
//
// C59, security review 2b2 finding 1: a code completes an enrolment at the
// provider while the record here refuses it, because the login verified a
// factor through another business in between. The provider-side factor is
// removed, and when the provider will not remove it, the orphan is not lost:
// the removal is asked again, and if that also fails an
// `account.factor_orphaned` event names it in the business it was enrolled in.
//
// No other refusal removes anything at the provider (rounds 7 and 8: the factor
// may be the one another tab has just recorded). A provider factor nothing
// records stays there; reconciling strays is issue #300.
//
// Those other refusals are in `c59-factor-orphan-kept.test.ts`, the orphans
// reported in `c59-factor-orphan-reported.test.ts`; the world the three share
// is `c59-factor-orphan-world.ts`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  removeSecondFactor,
  verifySecondFactor,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  bravo,
  callerFor,
  db,
  events,
  factorIn,
  namingProvider,
  openWorld,
  personIn,
  race,
  serverUrl,
} from './c59-factor-orphan-world.ts';
import { consoleLine } from '../support/console-text.ts';

openWorld();

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: a provider factor that will not be removed after a refused enrolment is asked again and recorded as orphaned', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const { code, asked } = await race({ ok: false, fault: 'unreachable' });

      expect(code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['verify', 'remove', 'remove']);
      const orphaned = await events(bravo, 'account.factor_orphaned');
      expect(
        orphaned.slice(before).map(({ outcome, refusal_code }) => ({ outcome, refusal_code })),
      ).toEqual([{ outcome: 'refused', refusal_code: 'PROVIDER_ANSWER_INVALID' }]);
    });

    it('C59: the orphan row carries the operation id of the refused verify attempt', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      await race({ ok: false, fault: 'unreachable' });

      const [orphan] = (await events(bravo, 'account.factor_orphaned')).slice(before);
      const attempt = (await events(bravo, 'account.factor_verify')).at(-1);
      expect(attempt?.outcome).toBe('refused');
      expect(orphan?.operation_id).not.toBeNull();
      expect(orphan?.operation_id).toBe(attempt?.operation_id);
    });

    it('C59: a losing enrolment refused FACTOR_ALREADY_ENROLLED under the lock removes its own unrecorded factor, and records no orphan', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const { code, asked } = await race({ ok: true, value: undefined });

      expect(code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['verify', 'remove']);
      expect(await events(bravo, 'account.factor_orphaned')).toHaveLength(before);
    });

    it('C59: a losing enrolment refused for a session the winner ended removes nothing at the provider, and is reported orphaned', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const answer = await race({ ok: true, value: undefined }, true);

      expect(answer).toEqual({ code: 'AUTH_SESSION_EXPIRED', asked: ['verify'] });
      // Security review 2b2 r11-2(a): verified at the provider, unrecorded here.
      expect(await events(bravo, 'account.factor_orphaned')).toHaveLength(before + 1);
    });
  },
);

/** Mia's membership in bravo ends: login resolution there now refuses her. */
async function endMembership(person: string): Promise<void> {
  await db.app.withBusiness(bravo, (tx) =>
    tx.query('update memberships set active = false, ended_at = now() where person_id = $1', [
      person,
    ]),
  );
}

/** What reached the server log while `act` ran, and whether it names anything in clear. */
async function logged(act: () => Promise<unknown>): Promise<string[]> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await act();
    return warn.mock.calls.map((call) => consoleLine(...call));
  } finally {
    warn.mockRestore();
  }
}

function expectDigestOnly(lines: string[], subject: string, factorId: string) {
  const orphaned = lines.filter((line) => line.includes('account.factor_orphaned'));
  expect(orphaned).toHaveLength(1);
  const [line = ''] = orphaned;
  expect(line).toContain(`business=${bravo}`);
  expect(line).toMatch(/operation=[0-9a-f-]{36}\b/u);
  expect(line).toMatch(/subject=[0-9a-f]{64}\b/u);
  for (const clear of [subject, factorId, 'Mia', 'aal1-access-token', 'aal2']) {
    expect(line).not.toContain(clear);
  }
}

describe.skipIf(serverUrl === undefined)(
  'C59 a stray the record cannot hold is still reported (security review 2b2 r12-1)',
  () => {
    it('C59: a good code while the membership is ended reports the orphan to the server log, digest only', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const f = await factorIn(person, subject, false);
      const { provider, asked } = namingProvider(async () => await endMembership(person));
      const caller = callerFor(subject);
      const tab = { ...caller, presented: { ...caller.presented, sessionId: randomUUID() } };
      let answer: unknown;

      const lines = await logged(async () => {
        answer = await verifySecondFactor(tab, { code: '123456' }, provider);
      });

      expect(answer).toHaveProperty('code');
      expect(asked).toEqual(['verify']);
      expectDigestOnly(lines, subject, f.providerFactorId);
    });

    it('C59: a provider removal that fails after the membership ended reports the orphan to the server log, digest only', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const f = await factorIn(person, subject, true);
      const { provider } = namingProvider();
      const failing: FactorProvider = {
        ...provider,
        remove: async () => {
          await endMembership(person);
          return { ok: false, fault: 'unreachable' };
        },
      };
      let answer: unknown;

      const lines = await logged(async () => {
        answer = await removeSecondFactor(callerFor(subject), { code: '123456' }, failing);
      });

      expect(answer).toHaveProperty('removed', true);
      expectDigestOnly(lines, subject, f.providerFactorId);
    });
  },
);
