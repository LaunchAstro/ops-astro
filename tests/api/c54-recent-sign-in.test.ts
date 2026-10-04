// SPDX-License-Identifier: AGPL-3.0-only
//
// `C54 recent sign-in`: the Agent pane's money answers ask C59's step-up, the
// one check in the envelope (`prepare.ts`), and no second copy of it. Each
// answer that records or moves money holds `billing:decide`, so it is in the
// money set: an unknown effect's outcome (`budget.record_outcome`), its
// write-off (`budget.write_off`), the task's top-up (`budget.top_up`) and the
// top-up at a budget stop (`run.top_up`). Through the real API over a fresh
// Postgres, with the installation's money step-up setting:
// - on: a second factor past sixty minutes is refused `STEP_UP_REQUIRED` and
//   writes nothing; the same body on a fresh factor is admitted;
// - off: the stale sign-in is admitted;
// - another business's setting never applies, either way round;
// - the agent prefix is refused `DELEGATION_EXCLUDES_OPERATION` with the
//   setting on or off, as C59 rules for every money command: an agent never
//   holds a money key, so the setting opens nothing to it.
// Each answer is in S0-5's step-up sweep (`tests/operations/s0-5-step-up-sweep.test.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isMoneyKey,
  MONEY_STEP_UP_SETTING,
} from '../../packages/core-records/src/authority/step-up.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { declarationOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { PROPOSAL, type Prepared } from '../acceptance/role-case-bodies.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { answerAtTheStop } from '../acceptance/stopped-run.ts';
import { serverUrl, tokenFor, type Answer } from '../acceptance/world.ts';
import { agentOnWork, billingHolder, signed, type Signed } from './c54-fixture.ts';

/** C54's answers that record or move money: each holds `billing:decide`. */
const C54_MONEY: readonly CommandName[] = [
  'budget.record_outcome',
  'budget.write_off',
  'budget.top_up',
  'run.top_up',
];

/** The owner's sixty minutes, written here so a widened window fails. */
const OWNER_WINDOW_SECONDS = 60 * 60;

/** A refusal writes its audit event and its operation row, and nothing else. */
const BOOKKEEPING: ReadonlySet<string> = new Set([
  'audit_events',
  'operations',
  'authentication_attempts',
]);

describe('C54 recent sign-in (catalogue)', () => {
  it('C54 recent sign-in: each money answer holds a key in the money set, so the envelope asks the step-up', () => {
    const asked = C54_MONEY.map((name) => {
      const { collection, action } = declarationOf(name);
      return [name, `${collection}:${action}`, isMoneyKey(collection, action)];
    });
    expect(asked).toStrictEqual(C54_MONEY.map((name) => [name, 'billing:decide', true]));
  });
});

const serverMissing = serverUrl === undefined;

if (serverMissing) {
  console.warn('C54 recent sign-in: DATABASE_URL is unset, so the database cases did not run.');
}

// eslint-disable-next-line max-lines-per-function -- one world, the setting moved across it
describe.skipIf(serverMissing)('C54 recent sign-in', { timeout: 120_000 }, () => {
  let harness: Harness;
  let bravoHolder: Signed;
  let credential: string;

  const admin = async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> =>
    (await harness.world.db.admin.execute<T & Record<string, unknown>>(sql, [...params])) as T[];

  /** The installation's money step-up setting in one business. */
  const setStepUp = async (business: BusinessId, value: boolean): Promise<void> => {
    const updated = await admin<{ key: string }>(
      `update public.business_settings set value = $3::text::jsonb
        where business_id = $1 and key = $2 returning key`,
      [business, MONEY_STEP_UP_SETTING, JSON.stringify(value)],
    );
    expect(updated).toHaveLength(1);
  };

  /** A sign-in whose second factor was given one minute past the window. */
  const staleToken = async (subject: string): Promise<string> =>
    await tokenFor(subject, {
      secondFactor: true,
      signedInAt: Math.floor(Date.now() / 1000) - OWNER_WINDOW_SECONDS - 60,
    });

  /** Each public table's rows as one digest, read past row security. */
  async function fingerprint(): Promise<ReadonlyMap<string, string>> {
    const tables = await admin<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    const union = tables
      .map(
        ({ name }) =>
          `select '${name}' as name, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from public.${name} t`,
      )
      .join(' union all ');
    const rows = await admin<{ name: string; digest: string }>(union);
    return new Map(rows.map((row) => [row.name, row.digest]));
  }

  /**
   * A fresh positive body. A stopped run's delegation stays live while it
   * waits, and an agent holds one live delegation per purpose, so each stop
   * here is proposed under a purpose of its own.
   */
  async function bodyFor(name: CommandName): Promise<Readonly<Record<string, unknown>>> {
    const prepared: Prepared =
      name === 'run.top_up'
        ? await answerAtTheStop(harness, name, {
            ...PROPOSAL,
            purpose: `c54_recent_${randomUUID().replaceAll('-', '_')}`,
          })
        : await harness.positiveBody(declarationOf(name));
    if ('exception' in prepared) throw new Error(`c54: ${name}: ${prepared.exception}`);
    return prepared.body;
  }

  /** One money answer as ada, its body made fresh so each call has its own work. */
  async function answer(name: CommandName, token?: string): Promise<Answer> {
    const body = await bodyFor(name);
    return await harness.asPerson(name, body, 'alpha', {
      token: token ?? harness.world.ada.token,
    });
  }

  beforeAll(async () => {
    harness = await createHarness('c54_recent');
    const { world } = harness;
    bravoHolder = await billingHolder(world, world.bravo, 'bravo', 'bravo-holder');
    ({ credential } = await agentOnWork(world, signed(world.ada)));
  }, 240_000);

  afterAll(async () => await harness?.close());

  it('C54 recent sign-in: setting on, a factor past 60 minutes is refused STEP_UP_REQUIRED on each money answer and writes nothing; a fresh one is admitted', async () => {
    const { world } = harness;
    await setStepUp(world.alpha, true);
    const stale = await staleToken(world.ada.subject);
    const wrong: string[] = [];
    for (const name of C54_MONEY) {
      // Sequential: each answer's digest is its own.
      // oxlint-disable-next-line no-await-in-loop
      const body = await bodyFor(name);
      // oxlint-disable-next-line no-await-in-loop
      const before = await fingerprint();
      // oxlint-disable-next-line no-await-in-loop
      const refused = await harness.asPerson(name, body, 'alpha', { token: stale });
      // oxlint-disable-next-line no-await-in-loop
      const after = await fingerprint();
      const wrote = [...after.keys()].filter(
        (table) => !BOOKKEEPING.has(table) && after.get(table) !== before.get(table),
      );
      if (refused.status !== 403 || refused.code !== 'STEP_UP_REQUIRED' || wrote.length > 0) {
        wrong.push(`${name} stale: ${refused.status} ${refused.code} wrote [${wrote.join(', ')}]`);
      }
      // The same body on a fresh factor: the refusal was the step-up's, not the body's.
      // oxlint-disable-next-line no-await-in-loop
      const fresh = await harness.asPerson(name, body);
      if (fresh.code !== 'ok') wrong.push(`${name} fresh: ${fresh.status} ${fresh.code}`);
    }
    expect(wrong).toStrictEqual([]);
  });

  it('C54 recent sign-in: setting off, the same stale factor is admitted on each money answer', async () => {
    const { world } = harness;
    await setStepUp(world.alpha, false);
    try {
      const stale = await staleToken(world.ada.subject);
      const codes: string[] = [];
      for (const name of C54_MONEY) {
        // oxlint-disable-next-line no-await-in-loop
        codes.push(`${name} ${(await answer(name, stale)).code}`);
      }
      expect(codes).toStrictEqual(C54_MONEY.map((name) => `${name} ok`));
    } finally {
      await setStepUp(world.alpha, true);
    }
  });

  it('C54 recent sign-in: another business’s setting never applies, either way round', async () => {
    const { world } = harness;
    // Bravo off, alpha on: alpha's stale answer is still refused.
    await setStepUp(world.bravo, false);
    await setStepUp(world.alpha, true);
    const alphaStale = await answer('budget.record_outcome', await staleToken(world.ada.subject));
    expect([alphaStale.status, alphaStale.code]).toStrictEqual([403, 'STEP_UP_REQUIRED']);

    // Alpha off, bravo on: alpha's stale answer is admitted, bravo's stale
    // holder is refused in bravo, and fresh it reaches the body, which names
    // no task of bravo's.
    await setStepUp(world.alpha, false);
    await setStepUp(world.bravo, true);
    try {
      const alphaAdmitted = await answer(
        'budget.record_outcome',
        await staleToken(world.ada.subject),
      );
      expect(alphaAdmitted.code).toBe('ok');
      const body = { recordId: randomUUID(), amountMinor: 100, fromMaximumMinor: 3_000 };
      const bravoStale = await harness.asPerson('budget.top_up', body, 'bravo', {
        token: await staleToken(bravoHolder.presented.subject),
      });
      expect([bravoStale.status, bravoStale.code]).toStrictEqual([403, 'STEP_UP_REQUIRED']);
      const bravoFresh = await harness.asPerson('budget.top_up', body, 'bravo', bravoHolder);
      expect([bravoFresh.status, bravoFresh.code]).toStrictEqual([404, 'NOT_FOUND']);
    } finally {
      await setStepUp(world.alpha, true);
    }
  });

  it('C54 recent sign-in: the agent prefix is refused DELEGATION_EXCLUDES_OPERATION on each, setting on or off', async () => {
    const { world } = harness;
    const seen: string[] = [];
    for (const value of [true, false]) {
      // oxlint-disable-next-line no-await-in-loop
      await setStepUp(world.alpha, value);
      for (const name of C54_MONEY) {
        // oxlint-disable-next-line no-await-in-loop
        const refused = await harness.asAgent(name, await bodyFor(name), credential);
        seen.push(`${String(value)} ${name} ${refused.status} ${refused.code}`);
      }
    }
    await setStepUp(world.alpha, true);
    expect(seen).toStrictEqual(
      [true, false].flatMap((value) =>
        C54_MONEY.map((name) => `${String(value)} ${name} 403 DELEGATION_EXCLUDES_OPERATION`),
      ),
    );
  });
});
