// SPDX-License-Identifier: AGPL-3.0-only
//
// The one declaration of what "Duplicate without contents" carries of each
// task-content kind in the catalogue (S0-5's derivation: every write but
// task.create, task.set_party and map.scope), and how the shell case plants a canary in
// each kind this base can plant. A harness, not a suite.

import { COMMAND_SURFACE, TASK_STAGES } from '../../packages/core-wire/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { CANARY, alpha, as, clientA, clientStander, owner, revisionOf } from './duplicate-world.ts';

export type Carry = 'carried' | 'name only' | 'not carried';
type Plant = (taskId: string) => Promise<CommandResult>;

const writeOn =
  (command: string, fields: () => Record<string, unknown>): Plant =>
  async (taskId) =>
    await as(alpha, owner, {
      command,
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      fields: fields(),
    });

const commentOn = async (taskId: string): Promise<CommandResult> =>
  await as(alpha, owner, {
    command: 'task.comment',
    recordId: taskId,
    expectedRevision: await revisionOf(taskId),
    body: CANARY,
    audience: 'internal',
    commentType: 'note',
  });

const tagged = async (taskId: string): Promise<CommandResult> => {
  // A tag name holds 40 characters: the canary's first 40, which the shell case looks for.
  const tag = await as(alpha, owner, { command: 'tag.create', name: CANARY.slice(0, 40) });
  const tagId = isCommandRefusal(tag) ? '' : String(tag.recordId ?? tag.detail?.['tagId'] ?? '');
  return await as(alpha, owner, { command: 'task.add_tag', recordId: taskId, tagId });
};

/** The old task retyped to `build` and back to `task`: both writes in its type history. */
const retypedAndBack = async (taskId: string): Promise<CommandResult> => {
  const retype = async (taskType: string): Promise<CommandResult> =>
    await as(alpha, owner, {
      command: 'task.set_type',
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      taskType,
    });
  const there = await retype('build');
  return isCommandRefusal(there) ? there : await retype('task');
};

/** The old task shared with one of client A's people, who stands on it by a party grant. */
const shared = async (taskId: string): Promise<CommandResult> => {
  await clientStander(clientA);
  return await as(alpha, owner, {
    command: 'task.share_with_client',
    recordId: taskId,
    expectedRevision: await revisionOf(taskId),
  });
};

/**
 * Every task-content kind in the catalogue (S0-5's derivation: each write but
 * task.create, task.duplicate, task.set_party and map.scope), declared once: what a duplicate carries of
 * it, and how this test plants its canary. A kind this base cannot plant on a
 * plain task says why; a new kind with no row fails the first case.
 */
export const DECLARED: Readonly<
  Record<string, { readonly carry: Carry; readonly plant?: Plant | string }>
> = {
  'task.update': {
    carry: 'name only',
    plant: writeOn('task.update', () => ({
      title: `${CANARY} title`,
      description: CANARY,
      agent_brief: CANARY,
      page_link: `/tasks#${CANARY}`,
      estimated_minutes: 90,
      due: '2026-12-01',
    })),
  },
  'task.comment': { carry: 'not carried', plant: commentOn },
  'task.assign': {
    carry: 'not carried',
    plant: writeOn('task.assign', () => ({ assignee: owner.personId })),
  },
  'task.set_stage': {
    carry: 'not carried',
    plant: writeOn('task.set_stage', () => ({ stage: TASK_STAGES.list()[1]?.id })),
  },
  'task.set_scores': {
    carry: 'not carried',
    plant: writeOn('task.set_scores', () => ({ impact: 7, confidence: 6, ease: 5 })),
  },
  'task.set_adhoc': {
    carry: 'not carried',
    plant: writeOn('task.set_adhoc', () => ({ ad_hoc: true })),
  },
  'task.set_category': {
    carry: 'not carried',
    plant: writeOn('task.set_category', () => ({ category: 'seo' })),
  },
  // A retype and back (WF-1): the old task keeps `type` and its `type_history`, the shell
  // neither; it ends untyped, so the share planted below still applies.
  'task.set_type': { carry: 'not carried', plant: retypedAndBack },
  'map.revise': { carry: 'not carried', plant: 'revises a map; the duplicated task is none' },
  // WF-2: the shell is a new task, so none of a ticket's chart, claim, blocking or close.
  'map.chart': { carry: 'not carried', plant: 'charts a new map; the duplicated task is none' },
  'map.graduate': { carry: 'not carried', plant: 'graduates a map’s fog; the task is no map' },
  'task.claim': { carry: 'not carried', plant: 'the assignee, planted by task.assign' },
  'task.set_blocking': { carry: 'not carried', plant: 'blocks links: needs a second task' },
  'task.resolve': { carry: 'not carried', plant: 'ends the old task; task.start plants state' },
  'task.close_out_of_scope': { carry: 'not carried', plant: 'a ticket of a map only' },
  'task.start': {
    carry: 'not carried',
    plant: async (taskId) =>
      await as(alpha, owner, {
        command: 'task.start',
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
      }),
  },
  'time.log': {
    carry: 'not carried',
    plant: async (taskId) =>
      await as(alpha, owner, { command: 'time.log', taskId, duration: '30m', note: CANARY }),
  },
  'tag.create': { carry: 'not carried', plant: tagged },
  'task.add_tag': { carry: 'not carried', plant: 'planted by the tag.create row, which adds it' },
  'task.complete': { carry: 'not carried', plant: 'ends the old task; task.start plants state' },
  'task.reopen': { carry: 'not carried', plant: 'needs a completed task; state as task.start' },
  'task.set_state': { carry: 'not carried', plant: 'state, planted by task.start' },
  'task.propose': { carry: 'not carried', plant: 'needs a budget cap and a runtime world' },
  'task.decide': { carry: 'not carried', plant: 'needs a proposal' },
  'task.pickup': { carry: 'not carried', plant: 'needs an approved reservation' },
  'task.handback': { carry: 'not carried', plant: 'needs a lease' },
  'task.heartbeat': { carry: 'not carried', plant: 'needs a lease' },
  'task.dispatch': { carry: 'not carried', plant: 'needs a lease' },
  'task.observe': { carry: 'not carried', plant: 'needs a dispatched attempt' },
  'task.cancel': { carry: 'not carried', plant: 'needs a lineage' },
  'task.restart': { carry: 'not carried', plant: 'needs a lineage' },
  'budget.top_up': { carry: 'not carried', plant: 'needs an open envelope' },
  'budget.record_outcome': { carry: 'not carried', plant: 'needs an unknown attempt' },
  'budget.write_off': { carry: 'not carried', plant: 'needs an unknown hold' },
  'task.triage': { carry: 'not carried', plant: 'intake_state: an intake task only' },
  'task.set_audience': { carry: 'not carried', plant: 'client_visible needs a client share' },
  'task.share_with_client': { carry: 'not carried', plant: shared },
  'task.revoke_client_share': { carry: 'not carried', plant: 'needs a share' },
  'task.edit_comment': { carry: 'not carried', plant: 'rewrites a comment, planted above' },
  'task.delete_comment': { carry: 'not carried', plant: 'removes a comment' },
  'task.reparent': { carry: 'not carried', plant: 'placement: the new task is top level' },
  'task.move': { carry: 'not carried', plant: 'placement: the new task is on no board' },
  'task.rank': { carry: 'not carried', plant: 'placement: ranked afresh' },
  'task.trash': { carry: 'not carried', plant: 'a trashed task is not duplicated' },
  'task.restore': { carry: 'not carried', plant: 'a batch, not a task' },
  'task.purge': { carry: 'not carried', plant: 'the business window, not a task' },
  'time.start': { carry: 'not carried', plant: 'a running entry; time.log plants time' },
  'time.stop': { carry: 'not carried', plant: 'a running entry; time.log plants time' },
  'time.set_note': { carry: 'not carried', plant: 'a note on time; time.log plants one' },
  'time.delete': { carry: 'not carried', plant: 'removes time' },
  'task.remove_tag': { carry: 'not carried', plant: 'removes a tag' },
  'inbox.seen': { carry: 'not carried', plant: 'the reader’s own stamp, not the task' },
  'notifications.set_channel': { carry: 'not carried', plant: 'a person’s setting' },
  'settings.set_four_eyes_threshold': { carry: 'not carried', plant: 'a business setting' },
  'settings.set_client_sign_off': { carry: 'not carried', plant: 'a business setting' },
  'grant.revoke': { carry: 'not carried', plant: 'authority, not task content' },
  'access.grant': { carry: 'not carried', plant: 'authority, not task content' },
  'access.revoke': { carry: 'not carried', plant: 'authority, not task content' },
  'access.end': { carry: 'not carried', plant: 'authority, not task content' },
  'access.reset_factor': { carry: 'not carried', plant: 'a sign-in factor, not task content' },
  'invitation.create': { carry: 'not carried', plant: 'a team invitation, not task content' },
  'invitation.resend': { carry: 'not carried', plant: 'a team invitation, not task content' },
  'invitation.revoke': { carry: 'not carried', plant: 'a team invitation, not task content' },
  'credential.issue': { carry: 'not carried', plant: 'authority, not task content' },
  'credential.revoke': { carry: 'not carried', plant: 'authority, not task content' },
  'session.end': { carry: 'not carried', plant: 'a sign-in, not task content' },
  'client.create': { carry: 'not carried', plant: 'a client of the business, not task content' },
  // C41-A: a client and its onboarding are not task content; a step's result is
  // a system comment on the step's own task, which a duplicate leaves behind.
  'record.create': { carry: 'not carried', plant: 'a client of the business, not task content' },
  'onboarding.start': { carry: 'not carried', plant: 'lays new tasks out, not task content' },
  'onboarding.step_result': { carry: 'not carried', plant: 'needs an onboarding step task' },
  'client.set_privacy': { carry: 'not carried', plant: "a client's settings, not task content" },
  'preference.save': { carry: 'not carried', plant: 'a person’s setting' },
  'preference.dismiss_tip': { carry: 'not carried', plant: 'a person’s setting' },
  'settings.set_money_step_up': { carry: 'not carried', plant: 'a business setting' },
  'settings.set_conversation_window': { carry: 'not carried', plant: 'a business setting' },
  'settings.set_retention_window': { carry: 'not carried', plant: 'a business setting' },
  'privacy.record_incident': { carry: 'not carried', plant: 'the privacy register, not a task' },
  'privacy.set_overseas_service': { carry: 'not carried', plant: 'the privacy register' },
  'privacy.set_data_class': { carry: 'not carried', plant: 'the privacy register' },
  'legal.draft_version': { carry: 'not carried', plant: 'a legal document, not a task' },
  'legal.approve_version': { carry: 'not carried', plant: 'a legal document, not a task' },
  'legal.publish_version': { carry: 'not carried', plant: 'a legal document, not a task' },
  'operations.record_gate_item': { carry: 'not carried', plant: 'the installation, not a task' },
  'operations.change_installation_mode': { carry: 'not carried', plant: 'the installation' },
  'delegation.revoke': { carry: 'not carried', plant: 'authority, not task content' },
  'conversation.start': { carry: 'not carried', plant: 'a person’s own conversation' },
  'conversation.message': { carry: 'not carried', plant: 'needs a conversation' },
  'conversation.rename': { carry: 'not carried', plant: 'needs a conversation' },
  'conversation.set_scope': { carry: 'not carried', plant: 'needs a conversation' },
  'conversation.set_model': { carry: 'not carried', plant: 'needs a conversation' },
  'task.check': { carry: 'not carried', plant: 'needs a lease' },
  'model.call': { carry: 'not carried', plant: 'needs a lease' },
  'run.top_up': { carry: 'not carried', plant: 'needs a run at its budget stop' },
  'run.end_at_budget_stop': { carry: 'not carried', plant: 'needs a run at its budget stop' },
  'run.revise_state': { carry: 'not carried', plant: 'needs a run' },
  'task.accept_plan': { carry: 'not carried', plant: 'needs a planning run’s plan gate' },
  'budget.set_planning_cap': { carry: 'not carried', plant: 'a business setting' },
  'run.delegate_child': { carry: 'not carried', plant: 'needs a lease' },
  'run.child_handback': { carry: 'not carried', plant: 'needs a child run' },
  'chat.send_direct': { carry: 'not carried', plant: 'a team conversation’s, never on a task' },
  'chat.mark_read': { carry: 'not carried', plant: 'the reader’s own marker, not the task' },
  // C33: an automation of the business, carrying no task.
  'activation.change': { carry: 'not carried', plant: 'an automation, not task content' },
  'definition.release': { carry: 'not carried', plant: 'an automation, not task content' },
  // C31: a business's custody key, never task content.
  'secret.set': { carry: 'not carried', plant: 'a business key, not task content' },
  'secret.clear': { carry: 'not carried', plant: 'a business key, not task content' },
  // C52-A: an activation's standing approval, carrying no task.
  'activation.adopt': { carry: 'not carried', plant: 'an automation, not task content' },
  'activation.roll_back': { carry: 'not carried', plant: 'an automation, not task content' },
  'activation.turn_off': { carry: 'not carried', plant: 'an automation, not task content' },
  'approval.revoke': { carry: 'not carried', plant: 'an automation, not task content' },
  // MP-14-7a: a repair names a connection, never task content.
  'connector.repair': { carry: 'not carried', plant: 'a connection, not task content' },
  // C80: a live correction is the site's, decided by its approver; a duplicate carries none.
  'live_correction.request': { carry: 'not carried', plant: 'needs a live site page' },
  'live_correction.decide': { carry: 'not carried', plant: 'needs a requested correction' },
  'settings.set_live_correction_approver': { carry: 'not carried', plant: 'a business setting' },
};

/** The carried name fields: each gets its canary and its old-client-name case. */
export const NAME_FIELDS = ['title', 'stepNames'] as const;

/** S0-5's derivation from the catalogue, read here rather than listed. */
export const contentKinds = (): readonly string[] =>
  COMMAND_SURFACE.filter(
    (one) =>
      one.kind === 'write' &&
      !['task.create', 'task.duplicate', 'task.set_party', 'map.scope'].includes(one.name),
  ).map((one) => one.name);

/** Plant every plantable kind on `taskId`, in order; the kinds planted, each with its answer. */
export async function plantEvery(taskId: string): Promise<readonly [string, CommandResult][]> {
  const planted: [string, CommandResult][] = [];
  for (const [kind, declared] of Object.entries(DECLARED)) {
    if (typeof declared.plant !== 'function') continue;
    // oxlint-disable-next-line no-await-in-loop -- each write reads the revision the last left
    planted.push([kind, await declared.plant(taskId)]);
  }
  return planted;
}
