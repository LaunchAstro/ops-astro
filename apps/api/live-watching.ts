// SPDX-License-Identifier: AGPL-3.0-only
//
// How a tab's stream asks about the topics it follows (C4), moved out of app.ts unchanged for
// a task: `task.execution`'s own admission, with the bearer verified again. C71 (CS-7.42) adds a
// team conversation, admitted for a current member alone (`reads/live-chat.ts`), and the board's
// question of whether its person is in a conversation that moved. None serves, audits or shows
// anything (C4 live-sync 6). The board's own questions (INB-1f) sit here too.

import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { EXPIRED_FIXES } from '../../packages/core-records/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import {
  admitConversations,
  boardReach,
  hearsConversation,
  joinLiveBoard,
  shownInbox,
  isCommandRefusal,
  refuseCommand,
  refuseNotFound,
} from '../../packages/core-commands/src/index.ts';
import type {
  admitReads,
  AdmissionAt,
  CommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { bearerOf, sessionCookieOf } from './auth/session.ts';
import type { Verifier } from './auth/supabase.ts';
import type { Gather } from './gather.ts';
import type { BoardQuestions } from './live-board.ts';
import type { Watch, Watching } from './live-follow.ts';
import { UNANSWERED, type Unanswered } from './live.ts';

/** What the questions need of the app: its database and its one way to verify a bearer. */
interface Door {
  readonly database: Database;
  readonly verify: Verifier;
}

/** The channel's task check: `reads/execute.ts`'s `admitReads`. */
interface Admitting {
  readonly admit: typeof admitReads;
}

type Answers = readonly (string | CommandRefusal)[] | CommandRefusal | Unanswered;
/** A task the caller may watch, and the person admitted to it. */
type Watched = { readonly taskId: string; readonly personId: string };
/** A stream's questions, and the person its door admitted: the only person its seat is for. */
export type DoorWatching = Watching & { readonly admitted: () => string | undefined };

export function watching(
  options: Door,
  live: Admitting,
  context: Context,
  businessId: string,
): DoorWatching {
  let admitted: string | undefined;
  // Door: the task's topic, its person kept as the stream's. Recheck: the person admitted now.
  const topics = (
    answers: readonly (Watched | CommandRefusal)[] | CommandRefusal | Unanswered,
    at: AdmissionAt,
  ) =>
    answers === UNANSWERED || isCommandRefusal(answers)
      ? answers
      : answers.map((answer) => {
          if (isCommandRefusal(answer)) return answer;
          if (at === 'recheck') return answer.personId;
          admitted ??= answer.personId;
          return answer.taskId;
        });
  const ask = async (watches: readonly Watch[], at: AdmissionAt) => {
    const tasks = watches.flatMap((watch) => (watch.kind === undefined ? [watch.taskId] : []));
    const chats = watches.flatMap((watch) => (watch.kind === undefined ? [] : [watch.taskId]));
    const forTasks = (
      tasks.length === 0
        ? []
        : perId(tasks, topics(await mayWatch(options, live, context, businessId, tasks, at), at))
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
    admitted: () => admitted,
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

/** One answer per id, in order: each its own, or the one refusal (or no answer) for all of them. */
function perId(
  ids: readonly string[],
  answers: Answers,
): readonly (string | CommandRefusal | Unanswered)[] {
  return answers === UNANSWERED || isCommandRefusal(answers) ? ids.map(() => answers) : answers;
}

/**
 * The bearer verified again, or the refusal an expired one is owed; no answer
 * when the provider could not be asked, which ends nothing.
 */
async function presentedOf(options: Door, context: Context) {
  const presented = await options.verify(context.req);
  if (presented === 'unavailable') return UNANSWERED;
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
  if (presented === UNANSWERED || isCommandRefusal(presented)) return presented;
  return await admitConversations(options.database, businessId, presented, conversationIds, at);
}

/**
 * Whether this caller may watch each task, asked after verifying the bearer
 * again, of `task.execution`'s own admission, the internal activity the channel
 * reports: expiry, a lost membership, a revoked grant, a trashed or foreign
 * task and any external reader all refuse. It serves and audits nothing, since
 * the channel shows the person no content (C4 live-sync 6). Each answer is its
 * refusal, or the task's identifier (the topic) and the person admitted.
 */
async function mayWatch(
  options: Door,
  live: Admitting,
  context: Context,
  businessId: string,
  taskIds: readonly string[],
  at: AdmissionAt,
): Promise<readonly (Watched | CommandRefusal)[] | CommandRefusal | Unanswered> {
  const presented = await presentedOf(options, context);
  if (presented === UNANSWERED || isCommandRefusal(presented)) return presented;
  const requests = taskIds.map((recordId) => ({ read: 'task.execution' as const, recordId }));
  const admitted = await live.admit(options.database, businessId, presented, requests, at);
  if (isCommandRefusal(admitted)) return admitted;
  return admitted.map((answer) => {
    if (isCommandRefusal(answer)) return answer;
    if (answer.recordId === undefined) throw new Error('task.execution admitted no task');
    return { taskId: answer.recordId, personId: answer.personId };
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

/**
 * Whether this caller may hold the board's stream (INB-1f), with the bearer
 * verified again; no answer when the sign-in provider could not be asked.
 */
export async function mayJoinBoard(
  options: Door,
  context: Context,
  businessId: string,
): Promise<{ readonly personId: string } | CommandRefusal | Unanswered> {
  const presented = await options.verify(context.req);
  if (presented === 'unavailable') return UNANSWERED;
  if (typeof presented !== 'object') {
    return refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES);
  }
  return await joinLiveBoard(options.database, businessId, presented);
}

/** A digest of the tasks the stream's own person reads now, with the bearer verified again. */
export async function mayReach(
  options: Door,
  context: Context,
  businessId: string,
  personId: string,
): Promise<string | undefined> {
  const presented = await options.verify(context.req);
  return typeof presented === 'object'
    ? await boardReach(options.database, businessId, presented, personId)
    : undefined;
}

/** What `inbox.read` shows the stream's own person now, asked with the bearer verified again. */
export async function mayShowInbox(
  options: Door,
  context: Context,
  businessId: string,
  personId: string,
): Promise<string | undefined> {
  const presented = await options.verify(context.req);
  if (typeof presented !== 'object') return undefined;
  return await shownInbox(options.database, businessId, presented, personId);
}

/** One board run's answers, in the order the rule asks them. */
interface Run {
  readonly tasks: string | undefined;
  readonly inbox: string | undefined;
  readonly joined: string | undefined | Unanswered;
}

/**
 * The board stream's questions (INB-1f) for one tab. A run's tasks digest,
 * inbox digest and join are asked in that order with one check of the bearer.
 * A run a signal woke is shared with the other boards of the same credential
 * whose runs a signal woke and that ask before it begins (`gather.ts`, #620);
 * the stream's own checks, at join and on the recheck, are its own. Every run asks again, so a bearer
 * revoked or remapped since is caught by that run (ORCH46); a join asked after
 * the run's own, a conversation's (C71), is asked afresh.
 */
export function boardQuestions(
  options: Door,
  context: Context,
  businessId: string,
  gather: Gather,
): BoardQuestions {
  let checked: ReturnType<Verifier> | undefined;
  const door: Door = {
    ...options,
    verify: async (request) => await (checked ??= options.verify(request)),
  };
  const credential = bearerOf(context.req) ?? sessionCookieOf(context.req) ?? randomUUID();
  const joinedNow = async (): Promise<string | undefined | Unanswered> => {
    const again = await mayJoinBoard(door, context, businessId);
    if (again === UNANSWERED) return again;
    return isCommandRefusal(again) ? undefined : again.personId;
  };
  let run: Promise<Run> | undefined;
  let joinTaken = false;
  let shared = false;
  const asked = async (personId: string): Promise<Run> => {
    const tasks = await mayReach(door, context, businessId, personId);
    const inbox = await mayShowInbox(door, context, businessId, personId);
    return { tasks, inbox, joined: await joinedNow() };
  };
  const ask = async (personId: string): Promise<Run> =>
    await (run ??= shared
      ? gather(
          `${businessId}\u0000${credential}\u0000${personId}`,
          async () => await asked(personId),
        )
      : asked(personId));
  return {
    newRun: (heard) => {
      checked = undefined;
      run = undefined;
      joinTaken = false;
      shared = heard;
    },
    reach: async (personId) => (await ask(personId)).tasks,
    shown: async (personId) => (await ask(personId)).inbox,
    joinedAs: async () => {
      if (run === undefined || joinTaken) return await joinedNow();
      joinTaken = true;
      return (await run).joined;
    },
    hears: hearing(door, context, businessId),
  };
}
