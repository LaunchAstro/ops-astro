// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-D direct messages under races: two first sends of one pair start one
// conversation, a message committed after the reader's marker still counts
// unread, and API.md names the statuses an invalid body or upTo answers.

// oxlint-disable no-await-in-loop
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  directConversation,
  readConversationTypes,
  writeComment,
  type ConversationTypes,
} from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Caller } from '../acceptance/cast.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

type Body = Readonly<Record<string, unknown>>;

/** A world id the test needs set; null fails the test where it is read. */
function present(id: string | null): string {
  if (id === null) throw new Error('the world left this id unset');
  return id;
}

/** A resolver's placeholder until its promise hands over the real one. */
function noop(): void {}

/** The status a docs row names for `FIELD_VALUE_INVALID`. */
function documented(line: string): string {
  return /`FIELD_VALUE_INVALID` (\d{3})/u.exec(line)?.[1] ?? 'none';
}

/** A promise and the call that settles it: one transaction held at a point. */
function signal(): { readonly fired: Promise<void>; readonly fire: () => void } {
  let fire: () => void = noop;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function typesOf(chat: ChatWorld): Promise<ConversationTypes> {
  const { world } = chat.harness;
  const types = await world.db.app.withBusiness(
    world.alpha,
    async (tx) => await readConversationTypes(tx),
  );
  if (types === undefined) throw new Error('conversation types not installed');
  return types;
}

async function messagesOf(
  chat: ChatWorld,
  reader: Caller,
  conversationId: string,
): Promise<ChatMessageView[]> {
  return (await chat.as(reader, 'chat.messages', { conversationId })).body[
    'messages'
  ] as ChatMessageView[];
}

const conversationOf = (answer: { readonly body: Body }): string =>
  String((answer.body['detail'] as Body)['conversationId']);

/**
 * A direct send on its own connection whose transaction (the envelope's) begins,
 * and so its now(), at once, and which reaches the pair lock and writes only
 * once released.
 */
function heldSend(
  chat: ChatWorld,
  types: ConversationTypes,
  [from, to]: readonly [Caller, Caller],
  body: string,
): { readonly begun: Promise<void>; readonly release: () => void; readonly done: Promise<void> } {
  const { world } = chat.harness;
  const gate = signal();
  const begun = signal();
  const own = connect(world.db.appUrl);
  const late = own.withBusiness(world.alpha, async (tx) => {
    await tx.query('select 1');
    begun.fire();
    await gate.fired;
    const id = await directConversation(tx, types, present(from.personId), present(to.personId));
    await writeComment(tx, types.commentTypeId, {
      taskId: null,
      conversationId: id,
      authorActorId: present(from.actorId),
      commentType: 'note',
      audience: 'direct',
      body,
      source: 'app',
    });
  });
  const done = late.then(async () => await own.close());
  return { begun: begun.fired, release: gate.fire, done };
}

async function concurrentFirstSends(chat: ChatWorld): Promise<void> {
  const { world } = chat.harness;
  const { tess } = chat;
  const types = await typesOf(chat);
  // Two connections of the application role: two requests at once.
  const a = connect(world.db.appUrl);
  const b = connect(world.db.appUrl);
  try {
    const gate = signal();
    const started = signal();
    const one = a.withBusiness(world.alpha, async (tx) => {
      const id = await directConversation(
        tx,
        types,
        present(world.ada.personId),
        present(tess.personId),
      );
      started.fire();
      await gate.fired;
      return id;
    });
    await started.fired;
    let secondDone = false;
    const two = b.withBusiness(world.alpha, async (tx) => {
      const id = await directConversation(
        tx,
        types,
        present(tess.personId),
        present(world.ada.personId),
      );
      secondDone = true;
      return id;
    });
    await pause(500);
    expect(secondDone).toBe(false);
    gate.fire();
    expect(await two).toBe(await one);
  } finally {
    await a.close();
    await b.close();
  }
  const pair = [world.ada.personId, tess.personId].toSorted().join(':');
  const rows = await world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.records where data ->> 'chat_pair' = $1`,
    [pair],
  );
  expect(rows[0]?.n).toBe('1');
}

async function lateCommitStaysUnread(chat: ChatWorld): Promise<void> {
  const { tess } = chat;
  const { mia } = chat.harness.world;
  const opening = await chat.send(mia, tess, 'opening');
  expect(opening.status, opening.text).toBe(200);
  const conversationId = conversationOf(opening);

  // Mia's first send: its transaction begins before her second; it reaches the
  // pair lock only after the second has committed, as a send held behind the
  // lock does.
  const first = heldSend(chat, await typesOf(chat), [mia, tess], 'sent first, committed last');
  await first.begun;
  await pause(50);
  const second = await chat.send(mia, tess, 'sent second, committed first');
  expect(second.status, second.text).toBe(200);

  // Tess opens the thread and reads everything there is to read.
  const newest = (await messagesOf(chat, tess, conversationId)).at(-1);
  expect(newest?.body).toBe('sent second, committed first');
  const marked = await chat.as(tess, 'chat.mark_read', {
    conversationId,
    upTo: String(newest?.at),
  });
  expect(marked.status, marked.text).toBe(200);

  first.release();
  await first.done;

  const after = await messagesOf(chat, tess, conversationId);
  expect(after.map((m) => m.body)).toContain('sent first, committed last');
  const view = (
    (await chat.as(tess, 'chat.conversations')).body['conversations'] as ChatConversationView[]
  ).find((one) => one.conversationId === conversationId);
  // Tess has never been shown it: it must be unread.
  expect(view?.unread).toBe(1);
}

async function documentedStatuses(chat: ChatWorld): Promise<void> {
  const { world } = chat.harness;
  const empty = await chat.send(world.ada, world.mia, '   ');
  const opening = await chat.send(world.ada, world.mia, 'for the marker');
  const bad = await chat.as(world.ada, 'chat.mark_read', {
    conversationId: conversationOf(opening),
    upTo: 'not a time',
  });
  expect([empty.code, bad.code]).toEqual(['FIELD_VALUE_INVALID', 'FIELD_VALUE_INVALID']);
  const api = readFileSync('docs/local/API.md', 'utf8');
  const row = (name: string): string =>
    api.split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
  expect([documented(row('chat.send_direct')), documented(row('chat.mark_read'))]).toEqual([
    String(empty.status),
    String(bad.status),
  ]);
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-D reviewer proofs', () => {
  let chat: ChatWorld;

  beforeAll(async () => {
    chat = await createChatWorld('c71dsol');
  }, 600_000);

  afterAll(async () => {
    await chat?.harness.close();
  });

  it('two concurrent first sends of one pair start one conversation', async () => {
    await concurrentFirstSends(chat);
  }, 600_000);

  it('a message whose send began before one the reader marked read, but committed after it, still counts unread', async () => {
    await lateCommitStaysUnread(chat);
  }, 600_000);

  it('API.md names the status chat.send_direct and chat.mark_read answer for an invalid body or upTo', async () => {
    await documentedStatuses(chat);
  }, 600_000);
});
