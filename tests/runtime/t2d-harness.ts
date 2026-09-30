// SPDX-License-Identifier: AGPL-3.0-only
//
// The T2d suite's harness (`t2d-settle.test.ts`): one approved, picked-up
// piece of synthetic work, the calls its lease holder makes, and the money
// rows it moves. Kept apart so the suite stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  createTask,
  freshPurpose,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World as sharedWorld, type Party } from './cq-8-world.ts';

/**
 * The shared world, except that a new business also opens a populated
 * envelope on its first task (900 held, 400 spent), so a foreign envelope a
 * settlement must not move exists to be compared (Sol review 1 on #124,
 * criterion 3).
 */
export function cq8World(s: Schedules): ReturnType<typeof sharedWorld> {
  const world = sharedWorld(s);
  return {
    ...world,
    party: async (key: string): Promise<Party> => {
      const party = await world.party(key);
      const capId = randomUUID();
      await s.db.admin.execute(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'default', 100000, 'AUD')`,
        [party.id, capId],
      );
      await s.db.admin.execute(
        `insert into public.task_envelopes
           (business_id, id, cap_id, task_id, maximum_minor, held_minor, actual_minor, currency)
         values ($1, $2, $3, $4, 5000, 900, 400, 'AUD')`,
        [party.id, randomUUID(), capId, party.tasks[0]?.id],
      );
      return party;
    },
  };
}

/** The estimated maximum the proposal asks a person to hold. */
export const MAXIMUM = 2_500;
export const PRICED = { item: 'synthetic_comment', quantity: 1 };
export const OVER = { item: 'synthetic_comment_long', quantity: 1 };

export interface Work {
  readonly taskId: string;
  readonly proposal: Detail;
  readonly decision: Detail;
  readonly picked: Detail;
  readonly credential: string;
  readonly attemptId: string;
}

type Body = Readonly<Record<string, unknown>>;

export interface T2dHarness {
  readonly work: () => Promise<Work>;
  readonly held: (w: Work, body: Body) => ReturnType<typeof asAgent>;
  readonly dispatched: (w: Work) => Promise<void>;
  readonly applied: (w: Work) => Promise<void>;
  readonly observeOf: (w: Work, extra?: Body) => ReturnType<typeof asAgent>;
  readonly money: (w: Work) => Promise<Record<string, unknown> | undefined>;
  readonly receiptOf: (attemptId: string, who?: Member) => ReturnType<typeof executeRead>;
  readonly auditsOf: (
    outcome: string,
  ) => Promise<readonly { readonly refusal_code: string | null; readonly attempted: unknown }[]>;
}

/** The suite's calls, on the schedules `get` returns once `beforeAll` has opened them. */
export function t2dHarness(get: () => Schedules): T2dHarness {
  async function work(): Promise<Work> {
    const taskId = await createTask(get(), `t2d ${randomUUID()}`);
    const body = {
      ...proposeBody(taskId, await revisionOf(get(), taskId), {
        purpose: freshPurpose(),
        maximumMinor: MAXIMUM,
      }),
      step: { kind: 'synthetic_comment', payload: {} },
    };
    const proposal = appliedDetail(await asPerson(get(), body), 'task.propose');
    const decision = await approve(get(), proposal);
    const picked = await pickup(get(), decision['reservationId']);
    return {
      taskId,
      proposal,
      decision,
      picked,
      credential: String(picked['credential']),
      attemptId: String(picked['attemptId']),
    };
  }

  const held = async (w: Work, body: Readonly<Record<string, unknown>>) =>
    await asAgent(
      get(),
      {
        operationId: randomUUID(),
        leaseId: w.picked['leaseId'],
        fence: w.picked['fence'],
        ...body,
      },
      w.credential,
    );

  const dispatched = async (w: Work) => {
    appliedDetail(await held(w, { command: 'task.dispatch' }), 'task.dispatch');
  };

  const applied = async (w: Work) => {
    await dispatched(w);
    appliedDetail(
      await asAgent(
        get(),
        {
          command: 'task.comment',
          operationId: effectOperationId(w.attemptId),
          recordId: w.taskId,
          body: 'The synthetic change, applied once. Nothing left the app.',
          audience: 'internal',
        },
        w.credential,
      ),
      'task.comment',
    );
  };

  const observeOf = async (w: Work, extra: Readonly<Record<string, unknown>> = {}) =>
    await held(w, { command: 'task.observe', attemptId: w.attemptId, ...extra });

  const money = async (w: Work) =>
    (
      await rows<Record<string, unknown>>(
        get(),
        `select res.state, res.held_minor::text as held, res.actual_minor::text as actual,
              att.state as attempt_state, att.outcome, att.actual_minor::text as attempt_actual,
              att.observed, env.held_minor::text as envelope_held,
              env.actual_minor::text as envelope_actual
         from public.reservations res
         join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
         join public.task_envelopes env on env.business_id = res.business_id and env.id = att.envelope_id
        where res.business_id = $1 and res.id = $2`,
        [get().business, w.decision['reservationId']],
      )
    )[0];

  const receiptOf = async (attemptId: string, who: Member = get().decider) =>
    await executeRead(get().db.app, get().business, who.presented, {
      read: 'task.receipt',
      attemptId,
    } as never);

  const auditsOf = async (outcome: string) =>
    await rows<{ readonly refusal_code: string | null; readonly attempted: unknown }>(
      get(),
      `select refusal_code, attempted from public.audit_events
      where business_id = $1 and command = 'task.observe' and outcome = $2
      order by occurred_at`,
      [get().business, outcome],
    );

  return { work, held, dispatched, applied, observeOf, money, receiptOf, auditsOf };
}
