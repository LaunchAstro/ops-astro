// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's positive control: the body each answer at the budget stop needs.
// An answer needs a run the broker really stopped at its approved ceiling,
// and only the run's worker makes a model call, so this is the one recipe
// that drives the agent as well as the person. It is its own file for T1h's
// reason (`role-case-bodies.ts` is the table; this is one journey).
//
// A harness, not a suite: nothing here runs on its own.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

type Call = (
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
  credential?: string,
) => Promise<Answer>;

/** What the journey needs from a harness: `role-case-bodies.ts`'s `BodyContext`, in part. */
export interface StopContext {
  readonly asPerson: Call;
  readonly asAgent?: Call;
  freshTask(title: string): Promise<{ readonly id: string; readonly revision: number }>;
}

/** The replay operation's priced maximum is 500 minor units: a 400 ceiling cannot hold one call. */
const UNDER_ONE_CALL = 400;

const detailOf = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

function expectOk(answer: Answer, what: string): void {
  if (answer.code !== 'ok') throw new Error(`matrix: ${what} refused ${answer.code}`);
}

/**
 * A run waiting at its approved ceiling: proposed under one call's price and
 * approved by the context's person, picked up by the agent, and stopped by the
 * broker at its first call. Answers the task and the run.
 */
async function stoppedRun(
  context: StopContext,
  asAgent: Call,
  proposal: Readonly<Record<string, unknown>>,
): Promise<{ readonly recordId: string; readonly runId: string }> {
  const task = await context.freshTask('a task whose run stops at its ceiling');
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...proposal,
    maximumMinor: UNDER_ONE_CALL,
  });
  expectOk(proposed, 'propose');
  const decided = await context.asPerson('task.decide', {
    gateId: detailOf(proposed)['gateId'],
    versionId: detailOf(proposed)['versionId'],
    decision: 'approve',
    note: 'approved under one call, so the first call stops it',
  });
  expectOk(decided, 'decide');
  const picked = await asAgent('task.pickup', {
    reservationId: detailOf(decided)['reservationId'],
  });
  expectOk(picked, 'agent pickup');
  const lease = detailOf(picked);
  const call = await asAgent(
    'model.call',
    {
      leaseId: lease['leaseId'],
      fence: lease['fence'],
      operation: 'model.replay_compose',
      fields: [{ name: 'tone', from: { recordId: task.id, key: 'title' } }],
    },
    String(lease['credential']),
  );
  // The approved ceiling reached: the run waits for a person (AW-05).
  if (call.code !== 'BUDGET_UNAVAILABLE') {
    throw new Error(`matrix: the call past the ceiling answered ${call.code}, not the stop`);
  }
  return { recordId: task.id, runId: String(lease['runId']) };
}

/**
 * The body for `run.top_up` or `run.end_at_budget_stop`, on a run of its own.
 * The context's person approved the plan, so they answer as its approver, and
 * the four-eyes band is off in the acceptance world, so one top-up completes.
 * A harness with no agent cannot stop a run, and says where the answer runs.
 */
export async function answerAtTheStop(
  context: StopContext,
  name: 'run.top_up' | 'run.end_at_budget_stop',
  proposal: Readonly<Record<string, unknown>>,
): Promise<{ readonly body: Record<string, unknown> } | { readonly exception: string }> {
  if (context.asAgent === undefined) {
    return {
      exception:
        'executed alternative: this harness has no agent to stop a run; the approver ' +
        'answers one over the person route in tests/broker/aw-05-budget-answer-routes.test.ts',
    };
  }
  const stopped = await stoppedRun(context, context.asAgent, proposal);
  return name === 'run.top_up'
    ? { body: { ...stopped, amountMinor: 1_000, currency: proposal['currency'] } }
    : { body: { ...stopped } };
}
