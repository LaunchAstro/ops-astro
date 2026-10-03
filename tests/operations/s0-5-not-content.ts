// SPDX-License-Identifier: AGPL-3.0-only
//
// The commands `s0-5-client-lock.test.ts` leaves out of task content, each
// with its reason. Every other command that writes a client-scoped kind must
// leave its marker on a task.

/** Commands that write a client-scoped kind but are not content on an existing task. */
export const NOT_CONTENT: Readonly<Record<string, string>> = {
  'task.create': 'the creation itself',
  'task.duplicate': 'creates a new task from the shell; the old task is untouched (MP-4-8)',
  'task.set_party': 'a client change, which the lock allows while the task is empty',
  'client.create': 'writes a client, not a task',
  'task.share_with_client': 'a share grant: who sees the task, not what it holds',
  'task.purge': 'removes the task; nothing is left to change the client of',
  'inbox.seen': "the caller's own seen stamp on an item, not the task's content",
  // SL12 (batch 3a): a conversation is its owner's; citing a task writes nothing on it.
  'conversation.start': "the caller's own conversation, which may cite a task",
  'conversation.message': "a message in the caller's own conversation",
  'conversation.rename': "the caller's own conversation's title",
  'conversation.set_scope': "the page the caller's own conversation is about",
  // C71-D: a team conversation is a record beside tasks; its message names no task.
  'chat.send_direct': 'a message in a team conversation, written with no task',
  'chat.mark_read': "the reader's own member row in a team conversation",
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
