// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2 (3eb0cc1), lane FR2-PROPOSE: `task.propose` through the
// person command entry, against a real database. Each describe reproduces one
// finding as a schedule that answered wrongly at 3eb0cc1 (prove before fix,
// owner direction 24 Sep 2026).
//
// - R2-RUNTIME-24: a non-string purpose, currency or lineageId reached a bound
//   parameter and faulted, where the operand's refusal is owed (API.md,
//   `task.propose`; `operands.ts`).
// - R2-RUNTIME-64: a payload that is not a JSON object was spread into one and
//   applied, so the stored bytes were not the bytes sent (`successor.ts`
//   `isFieldMap`; `prepare.ts` on a body the server quietly changes).
// - R2-AUTHORITY-34: LINEAGE_NOT_ON_TASK named the other task's id and the
//   presented lineage id (`refusal.ts`: a reason is about the rule).
// - R2-RUNTIME-52: a trashed task took a new proposal, and a stale revision
//   told the caller it was there (`tasks-controls.ts` restart; RUNTIME.md).
// - R2-RUNTIME-26: a proposal outside existing budget authority, in another
//   currency than the cap or over its room, was written with a gate nobody
//   can approve (TRANSACTION-CONTRACT T1).
// - R2-RUNTIME-25: a version proposed and approved between the proposal's
//   unlocked read of the live version and its locks faulted, where one retry
//   is owed (RUNTIME.md, "costs one retry").

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  approve,
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
  scalar,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/final-r2-fr2-propose: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The entry threw rather than answering: the person is answered 503. */
interface Fault {
  readonly fault: string;
}

type Answer = CommandResult | Fault;

const isFault = (result: Answer): result is Fault => 'fault' in result;

async function attempt(s: Schedules, body: Body, database?: Database): Promise<Answer> {
  try {
    return await asPerson(s, body, database);
  } catch (cause) {
    return { fault: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
  }
}

/** The refusal code, `applied`, or the fault with its message. */
const answerOf = (result: Answer): string =>
  isFault(result) ? `fault ${result.fault}` : codeOf(result);

const namesOf = (result: Answer): unknown =>
  isFault(result) ? undefined : (result as { names?: unknown }).names;

async function outcomesOf(s: Schedules, operationId: unknown): Promise<readonly string[]> {
  return (
    await rows<{ outcome: string }>(
      s,
      `select outcome from public.audit_events
        where business_id = $1 and operation_id = $2 order by outcome`,
      [s.business, operationId],
    )
  ).map((each) => each.outcome);
}

async function versionsOn(s: Schedules, taskId: string): Promise<number> {
  return await scalar(
    s,
    `select count(*)::text as n from public.proposal_versions ver
       join public.proposal_lineages lin
         on lin.business_id = ver.business_id and lin.id = ver.lineage_id
      where ver.business_id = $1 and lin.task_id = $2`,
    [s.business, taskId],
  );
}

async function lineagesOn(s: Schedules, taskId: string): Promise<number> {
  return await scalar(
    s,
    `select count(*)::text as n from public.proposal_lineages where business_id = $1 and task_id = $2`,
    [s.business, taskId],
  );
}

const ABSENT = Symbol('absent');

/** A valid propose body on `taskId`, with each named field replaced, or removed when ABSENT. */
async function bodyWith(
  s: Schedules,
  taskId: string,
  changes: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    ...proposeBody(taskId, await revisionOf(s, taskId), { purpose: freshPurpose() }),
  };
  for (const [key, value] of Object.entries(changes)) {
    if (value === ABSENT) delete body[key];
    else body[key] = value;
  }
  return body;
}

describe.skipIf(serverUrl === undefined)('task.propose, final review round 2', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('fr2_propose', 1_000_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  // R2-RUNTIME-24 and R2-RUNTIME-64: each malformed operand is refused before
  // the write, by name, with nothing written and one refused audit row.
  const operandCases: readonly {
    readonly label: string;
    readonly changes: Readonly<Record<string, unknown>>;
    readonly code: string;
    readonly names: readonly string[];
  }[] = [
    {
      label: 'purpose absent',
      changes: { purpose: ABSENT },
      code: 'FIELD_VALUE_INVALID',
      names: ['purpose'],
    },
    {
      label: 'purpose null',
      changes: { purpose: null },
      code: 'FIELD_VALUE_INVALID',
      names: ['purpose'],
    },
    {
      label: 'purpose true',
      changes: { purpose: true },
      code: 'FIELD_VALUE_INVALID',
      names: ['purpose'],
    },
    {
      label: 'currency absent',
      changes: { currency: ABSENT },
      code: 'FIELD_VALUE_INVALID',
      names: ['currency'],
    },
    {
      label: 'currency null',
      changes: { currency: null },
      code: 'FIELD_VALUE_INVALID',
      names: ['currency'],
    },
    {
      label: 'currency true',
      changes: { currency: true },
      code: 'FIELD_VALUE_INVALID',
      names: ['currency'],
    },
    {
      label: 'lineageId 5',
      changes: { lineageId: 5 },
      // Lead ruling (coordinator 33, line 5): the typed-identifier door in
      // `prepare.ts` answers a mistyped operand by name, as API.md says.
      code: 'FIELD_VALUE_INVALID',
      names: ['lineageId'],
    },
    {
      label: 'lineageId true',
      changes: { lineageId: true },
      // Lead ruling (coordinator 33, line 5): the typed-identifier door in
      // `prepare.ts` answers a mistyped operand by name, as API.md says.
      code: 'FIELD_VALUE_INVALID',
      names: ['lineageId'],
    },
    {
      label: 'payload string',
      changes: { payload: 'hello' },
      code: 'FIELD_VALUE_INVALID',
      names: ['payload'],
    },
    {
      label: 'payload array',
      changes: { payload: [1, 2] },
      code: 'FIELD_VALUE_INVALID',
      names: ['payload'],
    },
    {
      label: 'payload null',
      changes: { payload: null },
      code: 'FIELD_VALUE_INVALID',
      names: ['payload'],
    },
    {
      label: 'payload absent',
      changes: { payload: ABSENT },
      code: 'FIELD_VALUE_INVALID',
      names: ['payload'],
    },
    {
      label: 'step.payload array',
      changes: { step: { kind: 'compose', payload: [1] } },
      code: 'FIELD_VALUE_INVALID',
      names: ['step'],
    },
  ];

  it.each(operandCases)(
    'R2-RUNTIME-24/64: $label is refused $code by name, before any write',
    async ({ changes, code, names }) => {
      const taskId = await createTask(s, 'a proposal with one malformed operand');
      const body = await bodyWith(s, taskId, changes);
      const before = await versionsOn(s, taskId);

      const answer = await attempt(s, body);

      expect(answerOf(answer)).toBe(code);
      expect(namesOf(answer)).toStrictEqual(names);
      expect(await versionsOn(s, taskId)).toBe(before);
      expect(await outcomesOf(s, body['operationId'])).toStrictEqual(['refused']);
    },
    60_000,
  );

  it('R2-AUTHORITY-34: LINEAGE_NOT_ON_TASK names neither the other task nor the lineage', async () => {
    const own = await createTask(s, 'the task the caller proposes on');
    const other = await createTask(s, 'a sibling task with its own lineage');
    const lineage = String((await propose(s, other, { purpose: freshPurpose() }))['lineageId']);
    const body = await bodyWith(s, own, { lineageId: lineage });

    const answer = await attempt(s, body);

    expect(answerOf(answer)).toBe('LINEAGE_NOT_ON_TASK');
    const serialised = JSON.stringify(answer);
    expect(serialised).not.toContain(other);
    expect(serialised).not.toContain(lineage);
    expect(JSON.stringify((answer as { fixes?: unknown }).fixes)).not.toContain(own);
  }, 60_000);

  it('R2-RUNTIME-52: a trashed task answers task.propose as a task that is not there', async () => {
    const taskId = await createTask(s, 'a task with a proposal, then trashed');
    await propose(s, taskId, { purpose: freshPurpose() });
    const trashed = await asPerson(s, {
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
    });
    expect(codeOf(trashed)).toBe('applied');
    const lineages = await lineagesOn(s, taskId);

    const nowhere = await attempt(s, await bodyWith(s, taskId, { recordId: randomUUID() }));
    const stale = await attempt(s, await bodyWith(s, taskId, { expectedRevision: 1 }));
    const current = await attempt(s, await bodyWith(s, taskId, {}));

    const shape = (result: Answer) =>
      isFault(result)
        ? answerOf(result)
        : {
            code: codeOf(result),
            names: (result as { names?: unknown }).names,
            fixes: (result as { fixes?: unknown }).fixes,
          };
    expect(shape(nowhere)).toMatchObject({ code: 'NOT_FOUND' });
    expect(shape(stale)).toStrictEqual(shape(nowhere));
    expect(shape(current)).toStrictEqual(shape(nowhere));
    expect(await lineagesOn(s, taskId)).toBe(lineages);
  }, 60_000);
});

describe.skipIf(serverUrl === undefined)(
  'R2-RUNTIME-26: task.propose checks existing budget authority',
  () => {
    let s: Schedules;
    const LIMIT = 10_000;

    beforeAll(async () => {
      s = await openSchedules('fr2_propose_cap', LIMIT);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    /** Refused PROPOSAL_OUT_OF_SCOPE with no version written on the task. */
    async function refusedOutOfScope(taskId: string, changes: Readonly<Record<string, unknown>>) {
      const before = await versionsOn(s, taskId);
      const body = await bodyWith(s, taskId, changes);
      const answer = await attempt(s, body);
      return {
        answer: answerOf(answer),
        written: (await versionsOn(s, taskId)) - before,
        outcomes: await outcomesOf(s, body['operationId']),
      };
    }

    const refusedNothingWritten = {
      answer: 'PROPOSAL_OUT_OF_SCOPE',
      written: 0,
      outcomes: ['refused'],
    };

    it('with an open envelope: another currency, and a ceiling past the cap room, are refused', async () => {
      const taskId = await createTask(s, 'a task whose envelope is open in AUD');
      const purpose = freshPurpose();
      const first = await propose(s, taskId, { purpose, maximumMinor: 4_000 });
      await approve(s, first);

      expect(await refusedOutOfScope(taskId, { currency: 'USD' })).toStrictEqual(
        refusedNothingWritten,
      );
      expect(await refusedOutOfScope(taskId, { maximumMinor: LIMIT - 4_000 + 1 })).toStrictEqual(
        refusedNothingWritten,
      );
      // Controls: in the cap's currency, within its room, the proposal applies;
      // and a new version of the approved lineage may use the room its
      // superseded hold gives back.
      const within = await attempt(s, await bodyWith(s, taskId, { maximumMinor: LIMIT - 4_000 }));
      expect(answerOf(within)).toBe('applied');
      const successor = await attempt(
        s,
        await bodyWith(s, taskId, {
          lineageId: first['lineageId'],
          purpose,
          maximumMinor: LIMIT,
        }),
      );
      expect(answerOf(successor)).toBe('applied');
    }, 60_000);

    it('with no envelope yet: the business cap is the authority', async () => {
      const taskId = await createTask(s, 'a task with no envelope');
      expect(await refusedOutOfScope(taskId, { currency: 'USD' })).toStrictEqual(
        refusedNothingWritten,
      );
      expect(await refusedOutOfScope(taskId, { maximumMinor: LIMIT + 1 })).toStrictEqual(
        refusedNothingWritten,
      );
    }, 60_000);
  },
);

/** One transaction the entry opened, and the statements it ran, in order. */
interface Traced {
  readonly statements: string[];
}

/** A connection whose `withBusiness` transactions are traced; `after` can hold one there. */
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

/** `lockProposal`'s read of the lineage's live version. */
const LIVE_VERSION =
  /select id from public\.proposal_versions\s+where business_id = \$1 and lineage_id = \$2 and superseded_at is null/u;

describe.skipIf(serverUrl === undefined)(
  'R2-RUNTIME-25: propose rediscovers the live version',
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('fr2_propose_live', 1_000_000);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('a version proposed and approved in the window costs one retry, not a fault', async () => {
      const taskId = await createTask(s, 'a lineage whose live version moves under discovery');
      const purpose = freshPurpose();
      const first: Detail = await propose(s, taskId, { maximumMinor: 2_000, purpose });
      const lineageId = String(first['lineageId']);
      const body = proposeBody(taskId, await revisionOf(s, taskId), {
        lineageId,
        maximumMinor: 3_000,
        purpose,
      });

      // The schedule: after P's first read of the live version, Q proposes v2 on
      // the same lineage and R approves v2, both committed, so v2 is live and
      // holds a reservation P's first discovery never saw.
      let served = false;
      let reservationId = '';
      const connection = traced(racer(s), async (_transaction, text) => {
        if (served || !LIVE_VERSION.test(text)) return;
        served = true;
        const second = await propose(s, taskId, { lineageId, maximumMinor: 2_500, purpose });
        reservationId = String((await approve(s, second))['reservationId']);
      });
      let outcome: Answer;
      try {
        outcome = await attempt(s, body, connection.database);
      } finally {
        await connection.database.close();
      }

      expect(served).toBe(true);
      expect(answerOf(outcome)).toBe('applied');
      expect(
        connection.transactions.filter((each) => each.statements.some((t) => LIVE_VERSION.test(t))),
      ).toHaveLength(2);
      const held = await rows<{ state: string; classified_cause: string | null }>(
        s,
        `select state, classified_cause from public.reservations where business_id = $1 and id = $2`,
        [s.business, reservationId],
      );
      expect(
        held.map(({ state, classified_cause }) => ({ state, classified_cause })),
      ).toStrictEqual([{ state: 'abandoned', classified_cause: 'version_superseded' }]);
      expect(await outcomesOf(s, body['operationId'])).toStrictEqual(['applied']);
    }, 90_000);
  },
);
