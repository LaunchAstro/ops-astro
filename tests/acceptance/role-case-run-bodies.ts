// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for a run and the person's own lease, split from
// role-case-positive-body.ts when the main merge joined it past the line limit.

import {
  PROPOSAL,
  ownAppliedEffect,
  ownLease,
  type BodyContext,
  type Prepared,
} from './role-case-bodies.ts';
import { answerAtTheStop } from './stopped-run.ts';
import { revisedRunBody } from './revised-run.ts';

type RunCommand =
  | 'grant.revoke'
  | 'delegation.revoke'
  | 'model.call'
  | 'run.delegate_child'
  | 'run.child_handback'
  | 'run.top_up'
  | 'run.end_at_budget_stop'
  | 'run.revise_state';

type LeaseCommand =
  'task.heartbeat' | 'task.dispatch' | 'task.check' | 'task.observe' | 'task.receipt';

export async function runBody(name: RunCommand, context: BodyContext): Promise<Prepared> {
  switch (name) {
    case 'grant.revoke':
      // Its positive control is case (f): the admin revokes a member's read
      // through this route, and the member's next read is refused. A body
      // here would need a grant id, and the only way to one is the grant it
      // then takes away from a later case.
      return {
        exception: 'executed alternative: success asserted in case (f), ada grant.revoke row',
      };
    case 'delegation.revoke':
      // A delegation exists only after an agent's pickup, which this recipe
      // cannot make. The journey makes one and the admin revokes it through
      // this route, case (h), `k-revoke` rows.
      return {
        exception:
          'executed alternative: needs a pickup; ada revokes a live delegation in ' +
          'case (h), k-revoke rows',
      };
    case 'model.call':
    case 'run.delegate_child':
    case 'run.child_handback':
      // The run's worker's, never a person's: the person prefix refuses each
      // SCOPE_NOT_GRANTED (AW-01, AW-11, "n/a (system)"). The agent makes the
      // call under its delegation in the agent journey, case (h).
      return {
        exception:
          'executed alternative: the person prefix refuses it by design; the agent calls it ' +
          'in case (h)',
      };
    case 'run.top_up':
    case 'run.end_at_budget_stop':
      // A run the broker stopped at its approved ceiling (`stopped-run.ts`).
      return await answerAtTheStop(context, name, PROPOSAL);
    case 'run.revise_state':
      // MP-6-2: a proposal's planned run, its state revised under run:write.
      return await revisedRunBody(context, PROPOSAL);
  }
}

export async function leaseBody(name: LeaseCommand, context: BodyContext): Promise<Prepared> {
  switch (name) {
    case 'task.heartbeat':
      // The person renews their own lease (ledger line 38, "current lease
      // owner"). The agent's renewal is in the agent journey.
      return { body: await ownLease(context) };
    case 'task.dispatch':
      // The person marks their own lease's step dispatched (T2c1).
      return { body: await ownLease(context) };
    case 'task.check':
      // A check recorded under the person's own lease (MP-6-1). The agent's
      // check under its delegation is in the agent journey.
      return {
        body: { ...(await ownLease(context)), name: 'the admin checks', outcome: 'passed' },
      };
    case 'task.observe':
      // The person observes the effect they applied on their own lease (T2c2).
      return { body: await ownAppliedEffect(context) };
    case 'task.receipt': {
      // The receipt of an effect the person applied and observed (T2c2).
      const applied = await ownAppliedEffect(context);
      const observed = await context.asPerson('task.observe', applied);
      if (observed.code !== 'ok') throw new Error(`matrix: observe refused ${observed.code}`);
      return { body: { attemptId: applied.attemptId } };
    }
  }
}
