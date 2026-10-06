// SPDX-License-Identifier: AGPL-3.0-only
//
// How a tab's stream asks about the topics it follows (C4), moved out of
// app.ts unchanged for a task: `task.execution`'s own admission, with the
// bearer verified again. C71 (CS-7.42) adds a team conversation, admitted for
// a current member alone (`reads/live-chat.ts`), and the board's question of
// whether its person is in a conversation that moved. None serves, audits or
// shows anything (C4 live-sync 6).

import type { Context } from 'hono';
import { EXPIRED_FIXES } from '../../packages/core-records/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import {
  admitConversations,
  hearsConversation,
  isCommandRefusal,
  refuseCommand,
  refuseNotFound,
} from '../../packages/core-commands/src/index.ts';
import type {
  admitReads,
  AdmissionAt,
  CommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import type { Watch, Watching } from './live-follow.ts';

/** What the questions need of the app: its database and its one way to verify a bearer. */
interface Door {
  readonly database: Database;
  readonly verify: Verifier;
}

/** The channel's task check: `reads/execute.ts`'s `admitReads`. */
interface Admitting {
  readonly admit: typeof admitReads;
}

type Answers = readonly (string | CommandRefusal)[] | CommandRefusal;

export function watching(
  options: Door,
  live: Admitting,
  context: Context,
  businessId: string,
): Watching {
  const ask = async (watches: readonly Watch[], at: AdmissionAt) => {
    const tasks = watches.flatMap((watch) => (watch.kind === undefined ? [watch.taskId] : []));
    const chats = watches.flatMap((watch) => (watch.kind === undefined ? [] : [watch.taskId]));
    const forTasks = (
      tasks.length === 0
        ? []
        : perId(tasks, await mayWatch(options, live, context, businessId, tasks, at))
    ).values();
    // The door records one authentication attempt: a task's, when one is named.
    const chatsAt = tasks.length > 0 ? 'recheck' : at;
    const forChats = (
      chats.length === 0
        ? []
        : perId(chats, await mayFollow(options, context, businessId, chats, chatsAt))
    ).values();
    return watches.map(
      (watch) => (watch.kind === undefined ? forTasks : forChats).next().value ?? refuseNotFound(),
    );
  };
  return {
    businessId,
    atDoor: async (ids, watches) => await ask(watches ?? tasksOf(ids), 'door'),
    async again(id, watch) {
      const [answer] = await ask([watch ?? { label: '', taskId: id }], 'recheck');
      if (answer === undefined) throw new Error('the recheck answered no topic');
      return answer;
    },
  };
}

/** Task topics, unlabelled: what a caller naming ids alone follows. */
const tasksOf = (ids: readonly string[]): readonly Watch[] =>
  ids.map((taskId) => ({ label: '', taskId }));

/** One answer per id, in order: each its own, or the one refusal for all of them. */
function perId(ids: readonly string[], answers: Answers): readonly (string | CommandRefusal)[] {
  return isCommandRefusal(answers) ? ids.map(() => answers) : answers;
}

/** The bearer verified again, or the refusal an expired one is owed. */
async function presentedOf(options: Door, context: Context) {
  const presented = await options.verify(context.req);
  return typeof presented === 'object'
    ? presented
    : refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES);
}

/** Whether this caller may follow each conversation (C71), with the bearer verified again. */
async function mayFollow(
  options: Door,
  context: Context,
  businessId: string,
  conversationIds: readonly string[],
  at: AdmissionAt,
): Promise<Answers> {
  const presented = await presentedOf(options, context);
  if (isCommandRefusal(presented)) return presented;
  return await admitConversations(options.database, businessId, presented, conversationIds, at);
}

/**
 * Whether this caller may watch each task, asked after verifying the bearer
 * again, of `task.execution`'s own admission, the internal activity the channel
 * reports: expiry, a lost membership, a revoked grant, a trashed or foreign
 * task and any external reader all refuse. It serves and audits nothing, since
 * the channel shows the person no content (C4 live-sync 6). Each answer is its
 * refusal, or at the door the task's identifier, the topic, and on a recheck
 * the person admitted.
 */
async function mayWatch(
  options: Door,
  live: Admitting,
  context: Context,
  businessId: string,
  taskIds: readonly string[],
  at: AdmissionAt,
): Promise<Answers> {
  const presented = await presentedOf(options, context);
  if (isCommandRefusal(presented)) return presented;
  const requests = taskIds.map((recordId) => ({ read: 'task.execution' as const, recordId }));
  const admitted = await live.admit(options.database, businessId, presented, requests, at);
  if (isCommandRefusal(admitted)) return admitted;
  return admitted.map((answer) => {
    if (isCommandRefusal(answer)) return answer;
    if (answer.recordId === undefined) throw new Error('task.execution admitted no task');
    return at === 'door' ? answer.recordId : answer.personId;
  });
}

/** The board's question (C71): whether its person is in any of these conversations now. */
export function hearing(
  options: Door,
  context: Context,
  businessId: string,
): (personId: string, conversationIds: readonly string[] | 'any') => Promise<boolean> {
  return async (personId, conversationIds) => {
    const presented = await options.verify(context.req);
    if (typeof presented !== 'object') return false;
    return await hearsConversation(
      options.database,
      businessId,
      presented,
      personId,
      conversationIds,
    );
  };
}
