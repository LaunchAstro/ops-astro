// SPDX-License-Identifier: AGPL-3.0-only
//
// The task-content commands `s0-5-client-lock.test.ts` runs, read from the
// catalogue: every command that writes a client-scoped kind, less the ones
// below that are not content on an existing task. Split from
// `s0-5-client-lock-world.ts` so each stays under the per-file cap.

import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  type CommandDeclaration,
} from '../../packages/core-wire/src/index.ts';

/** Commands that write a client-scoped kind but are not content on an existing task. */
const NOT_CONTENT: Readonly<Record<string, string>> = {
  'task.create': 'the creation itself',
  'task.duplicate': 'creates a new task from the shell; the old task is untouched (MP-4-8)',
  'task.set_party': 'a client change, which the lock allows while the task is empty',
  // WF-1: `task-content.ts` excludes it from content alongside `task.set_party`.
  'map.scope': "a map's client change, which the lock allows while the map is empty",
  // WF-2: a chart files a new map and its tickets; it names no existing task.
  'map.chart': 'the creation of a map and its tickets, as task.create',
  'client.create': 'writes a client, not a task',
  'record.create': 'writes a client, not a task',
  'onboarding.start': "lays a template out as new tasks on the client, each one's creation",
  'client.set_privacy': "a client's privacy settings, not a task",
  'secret.set': 'a key held for a client or the business, not a task (C31)',
  // MP-14-10a: a client's standing mandates and graduation rows, not a task.
  'mandate.file': "a client's standing mandate, not a task",
  'mandate.revoke': "a client's standing mandate, not a task",
  'graduation.promote': "a client's graduation row and mandate, not a task",
  'graduation.demote': "a client's graduation row and mandate, not a task",
  'task.share_with_client': 'a share grant: who sees the task, not what it holds',
  'task.purge': 'removes the task; nothing is left to change the client of',
  'inbox.seen': "the caller's own seen stamp on an item, not the task's content",
  // SL12 (batch 3a): a conversation is its owner's; citing a task writes nothing on it.
  'conversation.start': "the caller's own conversation, which may cite a task",
  'conversation.message': "a message in the caller's own conversation",
  'conversation.rename': "the caller's own conversation's title",
  'conversation.set_scope': "the page the caller's own conversation is about",
  'chat.send_direct': 'a team conversation message (C71-D), a record beside tasks naming none',
  'chat.mark_read': "the reader's own member row in a team conversation (C71-D)",
  // C71-G: a group is a team conversation too; its commands write it and its members.
  'chat.start_group': 'a team group and its members, written with no task',
  'chat.send_group': 'a message in a team group, written with no task',
  'chat.rename_group': "a team group's own name",
  'chat.change_members': "a team group's member rows",
  'chat.leave': "the caller's own member row in a team group",
  'model.call':
    'the agent prefix only (the person path refuses it), under a lease: the task already has content',
  // SL11 (batch 3b): AW-11's two, agent-only like `model.call`.
  'run.delegate_child':
    "the agent prefix only, under the parent's lease: the task already has content",
  'run.child_handback':
    "the agent prefix only, on a child the parent's lease made: the task already has content",
};

export const CONTENT: readonly CommandDeclaration[] = COMMAND_SURFACE.filter(
  ({ name }) =>
    !(name in NOT_CONTENT) && COMMAND_EFFECTS[name].writes.some((kind) => kind.scope === 'client'),
);
