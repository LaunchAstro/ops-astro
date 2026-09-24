// SPDX-License-Identifier: AGPL-3.0-only
//
// Thermo O3: `task.propose` and a rejecting `task.decide` discover the holds
// their versions still own (`affectedByVersions`) before their locks, lock
// them, and then classify whatever is held under those locks. Neither read the
// held set again. A hold that appeared in between was met by
// `LockSet.require` inside the classifier, a plain `Error` that
// `isRetryableViolation` does not retry, so the request failed although the
// same body, sent again, applied. Both now rediscover the held set under the
// locks through the rediscovery module and roll back as `AffectedSetChanged`,
// retried once.
//
// Each schedule is forced between one statement and the next, as
// `retry-gaps.test.ts` does.
//
// - propose: an approval of the version being superseded commits in the
//   window, which opens its hold. Reachable: nothing the proposal holds before
//   its locks stops a decision.
// - decide (reject): no command can open a hold on a lineage whose gate is
//   still pending (a pending gate's version is not approved, and every older
//   version's hold was classified when it was superseded), so the hold is
//   revived by a test write in the window, the way
//   `lifecycle-authority-loss.test.ts` writes the state its replay case needs.
//   It proves the type, the retry and the answer, not a race.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  approve,
  approveBody,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  proposeBody,
  racer,
  revisionOf,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/o3-held-recheck: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** One transaction the entry opened, and the statements it ran, in order. */
interface Traced {
  readonly statements: string[];
}

/** A connection whose every `withBusiness` transaction is traced; `after` can hold one there. */
function traced(
  database: Database,
  after: (transaction: Traced, text: string) => Promise<void>,
): { readonly database: Database; readonly transactions: readonly Traced[] } {
  const transactions: Traced[] = [];
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> => {
        const transaction: Traced = { statements: [] };
        transactions.push(transaction);
        return await target.withBusiness(
          businessId,
          async (tx) =>
            await run(
              new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown;
                  return async (text: string, parameters: readonly unknown[] = []) => {
                    const found = await inner.query(text, parameters);
                    transaction.statements.push(text);
                    await after(transaction, text);
                    return found;
                  };
                },
              }),
            ),
        );
      };
    },
  });
  return { database: wrapped, transactions };
}

const ran = (transaction: Traced, pattern: RegExp): number =>
  transaction.statements.filter((text) => pattern.test(text)).length;

/** `affectedByVersions`: the held set a propose or a rejection discovers. */
const HELD_BY_VERSION = /'version_superseded' as cause/u;
const LOCKING = /\bfor (?:no key )?update\b/u;
const AUDIT_INSERT = /insert into audit_events/u;

describe.skipIf(serverUrl === undefined)('propose and reject rediscover their held set', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('o3_held_recheck', 1_000_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const outcomesOf = async (operationId: unknown): Promise<readonly string[]> =>
    (
      await rows<{ outcome: string }>(
        s,
        `select outcome from public.audit_events
          where business_id = $1 and operation_id = $2 order by outcome`,
        [s.business, operationId],
      )
    ).map((each) => each.outcome);

  const reservation = async (id: string) =>
    (
      await rows<{ state: string; classified_cause: string | null }>(
        s,
        `select state, classified_cause from public.reservations where business_id = $1 and id = $2`,
        [s.business, id],
      )
    )[0];

  /** The command, on a connection of its own, with `window` run once in its first attempt. */
  async function race(
    body: Body,
    window: () => Promise<void>,
  ): Promise<{ readonly outcome: CommandResult | Error; readonly attempts: readonly Traced[] }> {
    let served = false;
    const connection = traced(racer(s), async (transaction, text) => {
      if (served || !HELD_BY_VERSION.test(text) || ran(transaction, HELD_BY_VERSION) !== 1) return;
      served = true;
      await window();
    });
    let outcome: CommandResult | Error;
    try {
      outcome = await asPerson(s, body, connection.database);
    } catch (cause) {
      outcome = cause as Error;
    } finally {
      await connection.database.close();
    }
    expect(served).toBe(true);
    return {
      outcome,
      attempts: connection.transactions.filter((each) => ran(each, HELD_BY_VERSION) > 0),
    };
  }

  it('propose meeting an approval of the superseded version answers the first request after one retry', async () => {
    const taskId = await createTask(s, 'a revision whose version is approved under discovery');
    const purpose = freshPurpose();
    const first: Detail = await propose(s, taskId, { maximumMinor: 2_000, purpose });
    const body = proposeBody(taskId, await revisionOf(s, taskId), {
      lineageId: String(first['lineageId']),
      // Inside the 2,000 envelope the first approval opens (SOL-R3-3).
      maximumMinor: 1_500,
      purpose,
    });

    // The schedule: after the first attempt's unlocked read of the held set,
    // the version it is about to supersede is approved on another connection
    // and commits, opening a hold (and the task's envelope) those locks miss.
    let reservationId = '';
    const { outcome, attempts } = await race(body, async () => {
      reservationId = String((await approve(s, first))['reservationId']);
    });

    expect(outcome).not.toBeInstanceOf(Error);
    expect(codeOf(outcome as CommandResult)).toBe('applied');
    expect(attempts).toHaveLength(2);
    // The lost attempt discovered, locked and rediscovered, and wrote nothing.
    expect(ran(attempts[0]!, HELD_BY_VERSION)).toBe(2);
    expect(ran(attempts[0]!, LOCKING)).toBeGreaterThan(0);
    expect(ran(attempts[0]!, /insert into public\.proposal_versions/u)).toBe(0);
    expect(ran(attempts[0]!, AUDIT_INSERT)).toBe(0);
    // The retry locked the hold it now saw and classified it with the version.
    expect(await reservation(reservationId)).toStrictEqual({
      state: 'abandoned',
      classified_cause: 'version_superseded',
    });
    expect(await outcomesOf(body['operationId'])).toStrictEqual(['applied']);
  }, 60_000);

  it('a rejection meeting a hold it did not discover answers the first request after one retry', async () => {
    const taskId = await createTask(s, 'a rejection whose lineage regains a hold under discovery');
    const purpose = freshPurpose();
    const first: Detail = await propose(s, taskId, { maximumMinor: 2_000, purpose });
    const reservationId = String((await approve(s, first))['reservationId']);
    const second: Detail = await propose(s, taskId, {
      lineageId: String(first['lineageId']),
      // Inside the 2,000 envelope the first approval opens (SOL-R3-3).
      maximumMinor: 1_500,
      purpose,
    });
    // The first version's hold was classified when the second superseded it.
    expect((await reservation(reservationId))?.state).toBe('abandoned');
    const body: Body = { ...approveBody(second), decision: 'reject' };

    // The window's write undoes that classification (not a reachable schedule;
    // see the header): the hold and the envelope's held total. The attempt keeps
    // its recorded outcome, which the schema makes permanent.
    const { outcome, attempts } = await race(body, async () => {
      await s.db.app.withBusiness(s.business, async (tx) => {
        const revived = await tx.query<{ envelope_id: string; held_minor: string }>(
          `update public.reservations
              set state = 'held', classified_cause = null, classified_cause_id = null,
                  terminal_at = null
            where business_id = $1 and id = $2
            returning envelope_id, held_minor::text as held_minor`,
          [s.business, reservationId],
        );
        await tx.query(
          `update public.task_envelopes set held_minor = held_minor + $3
            where business_id = $1 and id = $2`,
          [s.business, revived[0]!.envelope_id, Number(revived[0]!.held_minor)],
        );
      });
    });

    expect(outcome).not.toBeInstanceOf(Error);
    expect(codeOf(outcome as CommandResult)).toBe('applied');
    expect(attempts).toHaveLength(2);
    expect(ran(attempts[0]!, HELD_BY_VERSION)).toBe(2);
    expect(ran(attempts[0]!, /insert into public\.gate_decisions/u)).toBe(0);
    expect(ran(attempts[0]!, AUDIT_INSERT)).toBe(0);
    // The retry locked the revived hold and classified it with the lineage.
    expect(await reservation(reservationId)).toStrictEqual({
      state: 'abandoned',
      classified_cause: 'lineage_rejected',
    });
    expect(await outcomesOf(body['operationId'])).toStrictEqual(['applied']);
  }, 60_000);
});
