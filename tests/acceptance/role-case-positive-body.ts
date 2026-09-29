// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipe table: `createPositiveBody`, the minimal valid
// body each declaration needs, built on the journeys in `role-case-bodies.ts`.
// Split from that file so each stays under the per-file cap; the seam is the
// same one: this is still the matrix's only knowledge of what a task is.

import { randomUUID } from 'node:crypto';
import { type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import {
  PROPOSAL,
  lineageOn,
  type Prepared,
  type BodyContext,
  batchOf,
  approvableGate,
  approvedReservationId,
  approvedTaskId,
  ownLease,
  ownAppliedEffect,
  ownUnknownAttempt,
} from './role-case-bodies.ts';
import { ownConversation } from './foreign-conversation.ts';

export function createPositiveBody(
  context: BodyContext,
): (declaration: CommandDeclaration) => Promise<Prepared> {
  // eslint-disable-next-line max-lines-per-function -- one recipe per declaration reads as a table
  return async function positiveBody(declaration: CommandDeclaration): Promise<Prepared> {
    const target = async (): Promise<Record<string, unknown>> => {
      const task = await context.freshTask(`a task for ${declaration.name}`);
      return { recordId: task.id, expectedRevision: task.revision };
    };
    switch (declaration.name) {
      case 'task.create':
        return { body: { fields: { title: 'the admin creates a task' } } };
      case 'task.update':
        return { body: { ...(await target()), fields: { title: 'edited by the admin' } } };
      case 'task.start':
      case 'task.complete':
      case 'task.trash':
        return { body: await target() };
      case 'task.reopen': {
        // Only a completed task can be reopened (`tasks-state.ts`), so this
        // completes one first and writes against the revision that move
        // produced rather than the one the create returned.
        const task = await context.freshTask('a task to complete and reopen');
        const done = await context.asPerson('task.complete', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return {
          body: {
            recordId: task.id,
            expectedRevision: Number(done.body['revision']),
            reason: 'the admin reopens it',
          },
        };
      }
      case 'task.comment':
        return { body: { ...(await target()), body: 'a note', audience: 'internal' } };
      case 'task.assign':
        return { body: { ...(await target()), fields: { assignee: context.assigneePersonId } } };
      case 'task.triage':
        return { body: { ...(await target()), fields: { intake_state: 'accepted' } } };
      case 'task.set_stage':
        return { body: { ...(await target()), fields: { stage: 'drafting' } } };
      case 'task.set_audience':
        return { body: { ...(await target()), fields: { client_visible: true } } };
      case 'task.set_party':
        // The party link takes a uuid and nothing in this tree resolves one:
        // the party model is not installed, and `tasks-state.ts` says so where
        // it excludes `client` from the person links it checks. So this is the
        // operation succeeding on a well-formed identifier, which is the whole
        // of what it claims to check — written down so a reader is not left
        // believing a party was proved to exist.
        return { body: { ...(await target()), fields: { client: randomUUID() } } };
      case 'task.reparent':
        return { body: { ...(await target()), parentId: null } };
      case 'task.move':
        return { body: { ...(await target()), board: null, boardSection: null } };
      case 'task.rank': {
        // Neighbours, never a number (specification 14.2 point 3), so a rank
        // needs a sibling to be ranked against: a lone task cannot be ranked.
        const neighbour = await context.freshTask('a neighbour to rank against');
        return { body: { ...(await target()), afterId: neighbour.id } };
      }
      case 'task.restore': {
        const task = await context.freshTask('a task to trash and restore');
        const trashed = await context.asPerson('task.trash', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return { body: { batchId: batchOf(trashed) } };
      }
      case 'task.purge': {
        // The purge takes no window: it reads the business's installed
        // retention_window_days, thirty days here, so this fresh trash stays
        // and the case proves the authority and the operation's reach. The
        // window boundary itself is `tests/commands/purge-retention.test.ts`.
        const task = await context.freshTask('a task to trash and purge');
        await context.asPerson('task.trash', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return { body: {} };
      }
      case 'task.propose':
        return { body: { ...(await target()), ...PROPOSAL } };
      case 'task.decide': {
        const gate = await approvableGate(context);
        return { body: { ...gate, decision: 'approve', note: 'the admin approves' } };
      }
      case 'task.pickup':
        // Person pickup (EX-01, transaction contract T3 line 66, minimum
        // contract line 331, ledger line 30): the admin claims approved work
        // as themselves. The agent's pickup is asserted in case (h).
        return { body: { reservationId: await approvedReservationId(context) } };
      case 'task.handback':
        // The person's own lease, handed back by that person. The agent's
        // own-lease handback is case (h), `k-handback` rows.
        return { body: { ...(await ownLease(context)), outcome: 'completed' } };
      case 'task.read':
      case 'task.execution':
        return { body: { recordId: context.alphaTaskId } };
      case 'task.board':
        return { body: { board: null } };
      // The pending gates the admin may decide: the admin holds `decide` on
      // the whole business, so the list answers.
      case 'gate.pending':
      case 'task.queue':
      case 'person.list':
      // Both take an empty body and neither carries an `expectedRevision`:
      // `settings.read` because `business_settings` has no revision column to
      // be stale against, `session.capabilities` because it reports the
      // caller's own grants and there is nothing of the caller's to be stale.
      // `settings.read` needs `settings:read`, which the seed grants the
      // admin; `session.capabilities` needs a live grant of any kind, which
      // the admin holds, so the admin reaches both here.
      case 'settings.read':
      case 'session.capabilities':
        return { body: {} };
      case 'preset.plan':
        return { body: { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] } };
      case 'settings.set_four_eyes_threshold':
        return { body: { value: 1200 } };
      case 'settings.set_client_sign_off':
        return { body: { value: true } };
      case 'budget.top_up':
        // The admin approved the plan and holds billing, so a top-up under
        // the band is hers alone (T2e).
        return {
          body: {
            recordId: await approvedTaskId(context),
            amountMinor: 100,
            fromMaximumMinor: PROPOSAL.maximumMinor,
          },
        };
      case 'budget.record_outcome':
        // The admin holds billing, so any unknown attempt on the business's
        // tasks is hers to record (O8, T3d1).
        return { body: { ...(await ownUnknownAttempt(context)), outcome: 'happened' } };
      case 'budget.write_off':
        // The same unknown hold, closed at nothing with a reason (T3c).
        return {
          body: {
            ...(await ownUnknownAttempt(context)),
            amountMinor: 0,
            reason: 'The matrix writes its own unknown hold off.',
          },
        };
      case 'task.cancel': {
        // A lineage to cancel is a proposal's, so one is proposed first.
        const task = await context.freshTask('a task whose lineage is cancelled');
        const lineageId = await lineageOn(context, task);
        return { body: { recordId: task.id, lineageId, reason: 'the admin cancels it' } };
      }
      case 'task.restart': {
        // Only a rejected or cancelled lineage is restarted, so this one is
        // proposed and cancelled through the routes before the restart.
        const task = await context.freshTask('a task whose lineage is restarted');
        const lineageId = await lineageOn(context, task);
        const cancelled = await context.asPerson('task.cancel', {
          recordId: task.id,
          lineageId,
          reason: 'cancelled so it can be restarted',
        });
        if (cancelled.code !== 'ok') throw new Error(`matrix: cancel refused ${cancelled.code}`);
        return { body: { recordId: task.id, lineageId } };
      }
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
      // AW-03. The admin holds `conversation:write`, so starts one of their own;
      // the message and the read name a conversation the admin just started.
      case 'conversation.start':
        return { body: { body: 'the admin asks the agent', subject: 'acceptance' } };
      case 'conversation.message':
        return { body: { conversationId: await ownConversation(context), body: 'and again' } };
      case 'conversation.read':
        return { body: { conversationId: await ownConversation(context) } };
      default:
        throw new Error(`matrix: no positive control recipe for ${String(declaration.name)}`);
    }
  };
}
