// SPDX-License-Identifier: AGPL-3.0-only
//
// The one declaration of what "Duplicate without contents" carries of each
// task-content kind in the catalogue (S0-5's derivation: every write but
// task.create and task.set_party), and how the shell case plants a canary in
// each kind this base can plant. A harness, not a suite.

import { COMMAND_SURFACE, TASK_STAGES } from '../../packages/core-wire/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { CANARY, alpha, as, owner, revisionOf } from './duplicate-world.ts';

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
    body: CANARY,
    audience: 'internal',
    commentType: 'comment',
  });

const tagged = async (taskId: string): Promise<CommandResult> => {
  const tag = await as(alpha, owner, { command: 'tag.create', name: CANARY });
  const tagId = isCommandRefusal(tag) ? '' : String(tag.recordId ?? tag.detail?.['tagId'] ?? '');
  return await as(alpha, owner, { command: 'task.add_tag', recordId: taskId, tagId });
};

/**
 * Every task-content kind in the catalogue (S0-5's derivation: each write but
 * task.create and task.set_party), declared once: what a duplicate carries of
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
  'task.add_tag': { carry: 'not carried', plant: tagged },
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
  'task.share_with_client': { carry: 'not carried', plant: 'needs the client model' },
  'task.revoke_client_share': { carry: 'not carried', plant: 'needs a share' },
  'task.edit_comment': { carry: 'not carried', plant: 'rewrites a comment, planted above' },
  'task.delete_comment': { carry: 'not carried', plant: 'removes a comment' },
  'task.reparent': { carry: 'not carried', plant: 'placement: the new task is top level' },
  'task.move': { carry: 'not carried', plant: 'placement: the new task is on no board' },
  'task.rank': { carry: 'not carried', plant: 'placement: ranked afresh' },
  'task.trash': { carry: 'not carried', plant: 'a trashed task is not duplicated' },
  'task.restore': { carry: 'not carried', plant: 'a batch, not a task' },
  'task.purge': { carry: 'not carried', plant: 'the business window, not a task' },
  'task.duplicate': { carry: 'not carried', plant: 'the old task keeps its own link only' },
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
  'delegation.revoke': { carry: 'not carried', plant: 'authority, not task content' },
};

/** The carried name fields: each gets its canary and its old-client-name case. */
export const NAME_FIELDS = ['title', 'stepNames'] as const;

/** S0-5's derivation from the catalogue, read here rather than listed. */
export const contentKinds = (): readonly string[] =>
  COMMAND_SURFACE.filter(
    (one) => one.kind === 'write' && one.name !== 'task.create' && one.name !== 'task.set_party',
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
