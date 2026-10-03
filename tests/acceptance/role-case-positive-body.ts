// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipe table: `createPositiveBody`, the minimal valid
// body each declaration needs, built on the journeys in `role-case-bodies.ts`.
// Split from that file so each stays under the per-file cap; the seam is the
// same one: this is still the matrix's only knowledge of what a task is.

import { type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import {
  ACCEPTED_PLAN,
  PROPOSAL,
  lineageOn,
  type Prepared,
  type BodyContext,
  batchOf,
  approvableGate,
  approvedReservationId,
  ownLease,
} from './role-case-bodies.ts';
import { answerAtTheStop } from './stopped-run.ts';
import { revisedRunBody } from './revised-run.ts';
import { commentChangeBody } from './role-case-comment-bodies.ts';
import { tagRecipes } from './tag-recipes.ts';
import { timeRecipes } from './time-recipes.ts';
import { privacyBody } from './role-case-privacy-bodies.ts';
import { credentialBody } from './role-case-credential-bodies.ts';
import { accessBody, madeClient } from './role-case-access-bodies.ts';
import { createGateBody } from './role-case-gate-bodies.ts';
import { conversationBody, leaseBody } from './role-case-run-bodies.ts';
import { FIXED_BODIES } from './role-case-fixed-bodies.ts';
import { moneyBody } from './role-case-money-bodies.ts';
import { lineageBody } from './role-case-lineage-bodies.ts';

export function createPositiveBody(
  context: BodyContext,
): (declaration: CommandDeclaration, author?: unknown) => Promise<Prepared> {
  const time = timeRecipes(context);
  const tags = tagRecipes(context);
  const gateBody = createGateBody(context);
  // eslint-disable-next-line max-lines-per-function -- one recipe per declaration reads as a table
  return async function positiveBody(
    declaration: CommandDeclaration,
    author?: unknown,
  ): Promise<Prepared> {
    const target = async (): Promise<Record<string, unknown>> => {
      const task = await context.freshTask(`a task for ${declaration.name}`);
      return { recordId: task.id, expectedRevision: task.revision };
    };
    const fixed = FIXED_BODIES[declaration.name];
    if (fixed !== undefined) return { body: { ...fixed } };
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
        // Only a completed task can be reopened (`tasks-state.ts`): complete one,
        // then write against that move's revision, not the create's.
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
      case 'task.set_state': {
        // A state id is the business's own, so it is read off a fresh task
        // (its first state), which is then started and set back to it.
        const task = await context.freshTask('a task to start and set back');
        const read = await context.asPerson('task.read', { recordId: task.id });
        const state = (read.body['task'] as { state: { id: string } | null }).state;
        const started = await context.asPerson('task.start', {
          recordId: task.id,
          expectedRevision: task.revision,
        });
        return {
          body: {
            recordId: task.id,
            expectedRevision: Number(started.body['revision']),
            stateId: state?.id,
          },
        };
      }
      case 'task.duplicate': {
        const task = await context.freshTask('a task to duplicate, to no client');
        return { body: { recordId: task.id, client: null, title: 'a copy', stepNames: [] } };
      }
      case 'task.comment':
        return { body: { ...(await target()), body: 'a note', audience: 'internal' } };
      case 'task.edit_comment':
      case 'task.delete_comment':
        return { body: await commentChangeBody(context, declaration.name, author) };
      case 'task.assign':
        return { body: { ...(await target()), fields: { assignee: context.assigneePersonId } } };
      case 'task.triage':
        return { body: { ...(await target()), fields: { intake_state: 'accepted' } } };
      case 'task.set_stage':
        return { body: { ...(await target()), fields: { stage: 'drafting' } } };
      case 'task.set_audience':
        return { body: { ...(await target()), fields: { client_visible: true } } };
      case 'task.set_scores':
        return { body: { ...(await target()), fields: { impact: 7, confidence: 9, ease: 8 } } };
      case 'task.set_adhoc':
        return { body: { ...(await target()), fields: { ad_hoc: true } } };
      case 'task.set_category':
        return { body: { ...(await target()), fields: { category: 'seo' } } };
      case 'task.share_with_client': {
        if (context.clientTask === undefined) return { body: await target() };
        const task = await context.clientTask('a task the admin shares with its client');
        return { body: { recordId: task.id, expectedRevision: task.revision } };
      }
      case 'task.revoke_client_share': {
        // A share to take back; sharing leaves the task's revision as it was.
        if (context.clientTask === undefined) return { body: await target() };
        const task = await context.clientTask('a task the admin shares, then takes back');
        const body = { recordId: task.id, expectedRevision: task.revision };
        const shared = await context.asPerson('task.share_with_client', body);
        if (shared.code !== 'ok') throw new Error(`matrix: share refused ${shared.code}`);
        return { body };
      }
      case 'task.set_party':
        // The party link names a client of this business (C32), made first.
        return { body: { ...(await target()), fields: { client: await madeClient(context) } } };
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
        // The purge reads the business's retention_window_days (thirty here),
        // so this fresh trash stays: the case proves authority and reach. The
        // window boundary is `tests/commands/purge-retention.test.ts`.
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
      case 'task.accept_plan': {
        const gate = await approvableGate(context);
        return { body: { ...gate, ...ACCEPTED_PLAN, note: 'the admin accepts the plan' } };
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
      // `trace.read` (AW-13 readers) asks `operations:read`, which the seed
      // grants the admin (C55).
      case 'task.read':
      case 'task.execution':
      case 'trace.read':
        return { body: { recordId: context.alphaTaskId } };
      case 'client.create':
      case 'access.grant':
      case 'access.revoke':
      case 'access.end':
      case 'access.reset_factor':
        return await accessBody(declaration.name, context);
      case 'inbox.seen': {
        // The caller's own item: a proposal raises a decision item for every
        // decide holder, the admin among them, read back from their inbox.
        await lineageOn(context, await context.freshTask('a task whose item is opened'));
        const listed = await context.asPerson('inbox.read', {});
        const items = listed.body['inbox'] as readonly Record<string, unknown>[];
        return { body: { itemId: String(items.at(-1)?.['id']) } };
      }
      // C81: the admin holds `privacy:manage`, as the owner does.
      case 'legal.draft_version':
      case 'legal.approve_version':
      case 'legal.publish_version':
      case 'privacy.set_overseas_service':
      case 'privacy.set_data_class':
      case 'privacy.draft_breach_notices':
      case 'privacy.record_incident':
        return await privacyBody(declaration.name, context);
      // API-2: the admin holds `credential:write`, as the owner does.
      case 'credential.issue':
      case 'credential.revoke':
        return await credentialBody(declaration.name, context);
      // S0-5: the admin holds `operations:manage` in alpha, which operates the
      // harness's installation.
      case 'operations.record_gate_item':
      case 'operations.change_installation_mode':
        return await gateBody(declaration.name);
      case 'budget.top_up':
      case 'budget.record_outcome':
      case 'budget.write_off':
      case 'budget.set_planning_cap':
        return { body: await moneyBody(context, declaration.name) };
      case 'task.cancel':
      case 'task.restart':
        return await lineageBody(declaration.name, context);
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
        return await answerAtTheStop(context, declaration.name, PROPOSAL);
      case 'run.revise_state':
        // MP-6-2: a proposal's planned run, its state revised under run:write.
        return await revisedRunBody(context, PROPOSAL);
      case 'harness.read': {
        // AW-12: the harness result on a proposal's planned run, under the admin's task read.
        const run = await revisedRunBody(context, PROPOSAL);
        return 'body' in run ? { body: { runId: run.body['runId'] } } : run;
      }
      case 'time.start':
      case 'time.stop':
      case 'time.log':
      case 'time.set_note':
      case 'time.delete':
        return await time[declaration.name]();
      case 'tag.create':
      case 'task.add_tag':
      case 'task.remove_tag':
      case 'tag.list':
        return await tags[declaration.name]();
      case 'task.heartbeat':
      case 'task.dispatch':
      case 'task.check':
      case 'task.observe':
      case 'task.receipt':
        // The person's own lease and the effect applied on it: `role-case-run-bodies.ts`.
        return await leaseBody(declaration.name, context);
      case 'conversation.start':
      case 'conversation.message':
      case 'conversation.read':
      case 'conversation.list':
      case 'conversation.allowance':
      case 'conversation.rename':
      case 'conversation.set_scope':
        // AW-03 and MP-7-11, the admin's own conversation: `role-case-run-bodies.ts`.
        return await conversationBody(declaration.name, context);
      default:
        throw new Error(`matrix: no positive control recipe for ${String(declaration.name)}`);
    }
  };
}
