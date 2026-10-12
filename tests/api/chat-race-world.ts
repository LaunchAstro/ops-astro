// SPDX-License-Identifier: AGPL-3.0-only
//
// What the chat race proofs share: a fresh direct conversation from Ada to a
// fresh reader, a database clock stepped back and put right, the reader's
// view as both chat reads answer it, and a count of lock waiters.

import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import { bearer, call, personPath, rebuildApi, type Answer } from '../acceptance/world.ts';
import type { ChatWorld } from './c71-d-world.ts';
import { CHAT, idOf } from './c71-d-lock-world.ts';

export interface Fresh {
  readonly reader: Caller;
  readonly conversationId: string;
}

/** Ada's first message to a new reader, both members since yesterday so a stepped clock hides nothing. */
export async function freshConversation(chat: ChatWorld, label: string): Promise<Fresh> {
  const { world } = chat.harness;
  const reader = await enrolCaller(world.db, world.alpha, 'alpha', label, CHAT);
  const first = await chat.send(world.ada, reader, `first to ${label}`);
  expect(first.status, first.text).toBe(200);
  const conversationId = idOf(first);
  await world.db.admin.execute(
    `update public.team_conversation_members set joined_at = joined_at - interval '1 day'
      where business_id = $1 and conversation_id = $2`,
    [world.alpha, conversationId],
  );
  return { reader, conversationId };
}

/** Steps the database clock back a minute; the answer puts it right. */
export async function stepClockBack(chat: ChatWorld): Promise<() => Promise<void>> {
  const { admin } = chat.harness.world.db;
  const [original] = await admin.execute<{ definition: string }>(
    `select pg_get_functiondef('pg_catalog.clock_timestamp()'::regprocedure) as definition`,
  );
  if (original === undefined) throw new Error('clock definition absent');
  // Only this suite's throwaway database sees the change. All product SQL still runs.
  await admin.execute(`create or replace function pg_catalog.clock_timestamp()
    returns timestamptz language sql volatile as $$ select now() - interval '1 minute' $$`);
  return async () => {
    await admin.execute(original.definition);
  };
}

/** The reader's conversation as both reads answer it: bodies in order, the marker and unread. */
export interface Seen {
  readonly bodies: readonly string[];
  readonly ats: readonly string[];
  readonly lastRead: string | null;
  readonly unread: number | undefined;
}

export async function seenBy(
  chat: ChatWorld,
  reader: Caller,
  conversationId: string,
): Promise<Seen> {
  const read = await chat.as(reader, 'chat.messages', { conversationId });
  expect(read.status, read.text).toBe(200);
  const listed = await chat.as(reader, 'chat.conversations');
  const view = (listed.body['conversations'] as ChatConversationView[]).find(
    (row) => row.conversationId === conversationId,
  );
  const messages = read.body['messages'] as ChatMessageView[];
  return {
    bodies: messages.map((m) => m.body),
    ats: messages.map((m) => m.at),
    lastRead: read.body['lastRead'] as string | null,
    unread: view?.unread,
  };
}

/** How many live messages carry this body. */
export async function messagesSaying(chat: ChatWorld, body: string): Promise<number> {
  const { world } = chat.harness;
  const [row] = await world.db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from public.records
      where business_id = $1 and data ->> 'body' = $2 and deleted_at is null`,
    [world.alpha, body],
  );
  return row?.n ?? 0;
}

/**
 * `name` sent by `caller` on an application instance of its own, over its own
 * connection, as a second serverless instance would send it: the world's own
 * instance holds one connection, which would run two calls one after the other.
 */
export async function onItsOwnInstance(
  chat: ChatWorld,
  caller: Caller,
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
): Promise<Answer> {
  const instance = rebuildApi(chat.harness.world);
  try {
    return await call(instance.api, personPath('alpha', pathOf(name)), body, bearer(caller.token));
  } finally {
    await instance.close();
  }
}

/** Waits until at least `n` backends of this database wait on an advisory lock. */
export async function advisoryWaiters(chat: ChatWorld, n: number): Promise<void> {
  const { admin } = chat.harness.world.db;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`,
    );
    if ((row?.n ?? 0) >= n) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`never saw ${n} advisory lock waiters`);
}
