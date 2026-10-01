// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipe table: `createPositiveBody`, the minimal valid
// body each declaration needs, built on the journeys in `role-case-bodies.ts`.
// Split from that file so each stays under the per-file cap; the seam is the
// same one: this is still the matrix's only knowledge of what a task is.

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
import { commentChangeBody } from './role-case-comment-bodies.ts';
import { tagRecipes } from './tag-recipes.ts';
import { timeRecipes } from './time-recipes.ts';
import { privacyBody } from './role-case-privacy-bodies.ts';
import { credentialBody } from './role-case-credential-bodies.ts';
import { accessBody, madeClient } from './role-case-access-bodies.ts';
import { createGateBody } from './role-case-gate-bodies.ts';

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
      case 'task.share_with_client': {
        if (context.clientTask === undefined) return { body: await target() };
        const task = await context.clientTask('a task the admin shares with its client');
        return { body: { recordId: task.id, expectedRevision: task.revision } };
      }
      case 'task.revoke_client_share':
        return { body: await target() };
      case 'task.set_party':
        // The party link names a client of this business (C32), so the admin
        // makes one first.
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
      case 'task.ledger':
        return { body: { timeZone: 'UTC' } };
      // An empty body, and no `expectedRevision`: `business_settings` has no revision column,
      // and `session.capabilities` reports the caller's own grants. The admin holds what each
      // asks: `settings:read`, `access:manage` and `operations:read` (C55, INB-1e), and a live
      // grant of any kind for `session.capabilities`, `client.list` (C32) and the inbox (INB-1d).
      // The person menu's two (C23) and the caller's own preferences (MP-2-11a) are its own.
      case 'task.queue':
      case 'person.list':
      case 'team.list':
      case 'settings.read':
      case 'session.capabilities':
      case 'session.person':
      case 'session.end':
      case 'preference.read':
      case 'access.read':
      case 'operations.read':
      case 'client.list':
      case 'inbox.read':
      case 'inbox.count':
      case 'inbox.unattended':
        // The caller's own inbox (INB-1d) needs a live grant of any kind, as
        // above; `inbox.unattended` needs `operations:read`, which the seed
        // grants the admin (INB-1e, C55).
        return { body: {} };
      case 'preference.save':
        return { body: { preference: 'appearance', value: 'dark' } };
      case 'preference.dismiss_tip':
        return { body: { page: 'agency:inbox', tip: 'triage', version: 1 } };
      case 'task.search':
        // A word no audit row carries, so digest-only is checked on it.
        return { body: { query: 'brochure' } };
      case 'client.create':
      case 'access.grant':
      case 'access.revoke':
      case 'access.end':
        return await accessBody(declaration.name, context);
      case 'notifications.set_channel':
        // Self-scoped (INB-1e): in-app is always on, the one mode it takes.
        return { body: { channel: 'in_app', mode: 'on' } };
      case 'inbox.seen': {
        // The caller's own item: a proposal raises a decision item for every
        // decide holder, the admin among them, read back from their inbox.
        await lineageOn(context, await context.freshTask('a task whose item is opened'));
        const listed = await context.asPerson('inbox.read', {});
        const items = listed.body['inbox'] as readonly Record<string, unknown>[];
        return { body: { itemId: String(items.at(-1)?.['id']) } };
      }
      case 'preset.plan':
        return { body: { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] } };
      case 'settings.set_four_eyes_threshold':
        return { body: { value: 1200 } };
      case 'settings.set_client_sign_off':
        return { body: { value: true } };
      case 'settings.set_money_step_up':
        return { body: { value: true } };
      // Inside C122-1's bounds whichever runs first: seven or more, and the
      // retention window never below the conversation window.
      case 'settings.set_conversation_window':
        return { body: { value: 14 } };
      case 'settings.set_retention_window':
        return { body: { value: 90 } };
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
      case 'task.todos':
        // The reader's own to-dos (MP-7-1): no operand.
        return { body: {} };
      case 'task.dispatch':
        // The person marks their own lease's step dispatched (T2c1).
        return { body: await ownLease(context) };
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
      default:
        throw new Error(`matrix: no positive control recipe for ${String(declaration.name)}`);
    }
  };
}
