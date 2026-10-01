// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipe table: `createPositiveBody`, the minimal valid
// body each declaration needs, built on the journeys in `role-case-bodies.ts`.
// Split from that file so each stays under the per-file cap; the seam is the
// same one: this is still the matrix's only knowledge of what a task is.

import { randomUUID } from 'node:crypto';
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
  moneyBody,
  ownLease,
} from './role-case-bodies.ts';
import { ownConversation } from './foreign-conversation.ts';
import { privacyBody } from './role-case-privacy-bodies.ts';
import { credentialBody } from './role-case-credential-bodies.ts';
import { accessBody, madeClient } from './role-case-access-bodies.ts';
import { createGateBody } from './role-case-gate-bodies.ts';
import { leaseBody, runBody } from './role-case-run-bodies.ts';

/** A team invitation to an address nobody holds yet. */
export const invitee = (): Record<string, unknown> => ({
  name: 'Invited Ivy',
  email: `ivy-${randomUUID()}@example.test`,
  role: 'member',
});

export function createPositiveBody(
  context: BodyContext,
): (declaration: CommandDeclaration) => Promise<Prepared> {
  const gateBody = createGateBody(context);
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
      // The pending gates the admin may decide: the admin holds `decide` on
      // the whole business, so the list answers.
      case 'gate.pending':
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
      // C39-T: the admin holds `access:share`; each recipe invites a new address.
      case 'invitation.create':
        return { body: invitee() };
      case 'invitation.resend':
      case 'invitation.revoke': {
        const made = await context.asPerson('invitation.create', invitee());
        if (made.code !== 'ok') throw new Error(`matrix: invitation refused ${made.code}`);
        return { body: { invitationId: String(made.body['recordId']) } };
      }
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
      case 'definition.attribution':
        return { body: { digest: 'a'.repeat(64) } };
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
      case 'budget.record_outcome':
      case 'budget.write_off':
      case 'budget.set_planning_cap':
        return { body: await moneyBody(context, declaration.name) };
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
      case 'delegation.revoke':
      case 'model.call':
      case 'run.delegate_child':
      case 'run.child_handback':
      case 'run.top_up':
      case 'run.end_at_budget_stop':
      case 'run.revise_state':
        return await runBody(declaration.name, context);
      case 'task.heartbeat':
      case 'task.dispatch':
      case 'task.check':
      case 'task.observe':
      case 'task.receipt':
        return await leaseBody(declaration.name, context);
      // AW-03. The admin holds `conversation:write`, so starts one of their own;
      // the message and the read name a conversation the admin just started.
      case 'conversation.start':
        return { body: { body: 'the admin asks the agent', subject: 'acceptance' } };
      case 'conversation.message':
        return { body: { conversationId: await ownConversation(context), body: 'and again' } };
      case 'conversation.read':
        return { body: { conversationId: await ownConversation(context) } };
      // MP-7-11. The tab row: the admin's own list, and a title and a page
      // on the conversation the admin just started.
      case 'conversation.list':
        return { body: {} };
      case 'conversation.rename':
        return { body: { conversationId: await ownConversation(context), title: 'Renamed' } };
      case 'conversation.set_scope':
        return {
          body: {
            conversationId: await ownConversation(context),
            page: { address: '/settings', shows: 'Settings' },
          },
        };
      default:
        throw new Error(`matrix: no positive control recipe for ${String(declaration.name)}`);
    }
  };
}
