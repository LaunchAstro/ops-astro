// SPDX-License-Identifier: AGPL-3.0-only
//
// Reviewer proofs for C71-D (SL10-26). Uncommitted; the orchestrator patches
// them to the builder.

// oxlint-disable no-await-in-loop
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  directConversation,
  readConversationTypes,
  writeComment,
} from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

type Body = Readonly<Record<string, unknown>>;

/** A resolver's placeholder until its promise hands over the real one. */
function noop(): void {}

/** The status a docs row names for `FIELD_VALUE_INVALID`. */
function documented(line: string): string {
  return /`FIELD_VALUE_INVALID` (\d{3})/u.exec(line)?.[1] ?? 'none';
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-D reviewer proofs', () => {
  let chat: ChatWorld;

  beforeAll(async () => {
    chat = await createChatWorld('c71dsol');
  }, 600_000);

  afterAll(async () => {
    await chat?.harness.close();
  });

  const conversationOf = (answer: { readonly body: Body }): string =>
    String((answer.body['detail'] as Body)['conversationId']);

  it('Sol proof, criterion 2: two concurrent first sends of one pair start one conversation', async () => {
    const { world } = chat.harness;
    const { tess } = chat;
    const types = await world.db.app.withBusiness(
      world.alpha,
      async (tx) => await readConversationTypes(tx),
    );
    if (types === undefined) throw new Error('conversation types not installed');
    // Two connections of the application role: two requests at once.
    const a = connect(world.db.appUrl);
    const b = connect(world.db.appUrl);
    try {
      let release: () => void = noop;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let begun: () => void = noop;
      const started = new Promise<void>((resolve) => {
        begun = resolve;
      });
      const one = a.withBusiness(world.alpha, async (tx) => {
        const id = await directConversation(tx, types, world.ada.personId, tess.personId);
        begun();
        await gate;
        return id;
      });
      await started;
      let secondDone = false;
      const two = b.withBusiness(world.alpha, async (tx) => {
        const id = await directConversation(tx, types, tess.personId, world.ada.personId);
        secondDone = true;
        return id;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(secondDone).toBe(false);
      release();
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
  }, 600_000);

  it('Sol proof, criterion 2: a message whose send began before one the reader marked read, but committed after it, still counts unread', async () => {
    const { world } = chat.harness;
    const { tess } = chat;
    const { mia } = world;
    const opening = await chat.send(mia, tess, 'opening');
    expect(opening.status, opening.text).toBe(200);
    const conversationId = conversationOf(opening);
    const types = await world.db.app.withBusiness(
      world.alpha,
      async (tx) => await readConversationTypes(tx),
    );
    if (types === undefined) throw new Error('conversation types not installed');

    // Mia's first send: its transaction (the envelope's) begins, and so its
    // now(), before her second; it reaches the pair lock only after the
    // second has committed, as a send held behind the lock does.
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun: () => void = noop;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const own = connect(world.db.appUrl);
    const late = own.withBusiness(world.alpha, async (tx) => {
      await tx.query('select 1');
      begun();
      await gate;
      const id = await directConversation(tx, types, mia.personId, tess.personId);
      await writeComment(tx, types.commentTypeId, {
        taskId: null,
        conversationId: id,
        authorActorId: mia.actorId,
        commentType: 'note',
        audience: 'direct',
        body: 'sent first, committed last',
        source: 'app',
      });
    });
    await started;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const second = await chat.send(mia, tess, 'sent second, committed first');
    expect(second.status, second.text).toBe(200);

    // Tess opens the thread and reads everything there is to read.
    const seen = (await chat.as(tess, 'chat.messages', { conversationId })).body[
      'messages'
    ] as ChatMessageView[];
    const newest = seen.at(-1);
    expect(newest?.body).toBe('sent second, committed first');
    const marked = await chat.as(tess, 'chat.mark_read', {
      conversationId,
      upTo: String(newest?.at),
    });
    expect(marked.status, marked.text).toBe(200);

    release();
    await late;
    await own.close();

    const after = (await chat.as(tess, 'chat.messages', { conversationId })).body[
      'messages'
    ] as ChatMessageView[];
    expect(after.map((m) => m.body)).toContain('sent first, committed last');
    const view = (
      (await chat.as(tess, 'chat.conversations')).body['conversations'] as ChatConversationView[]
    ).find((one) => one.conversationId === conversationId);
    // Tess has never been shown it: it must be unread.
    expect(view?.unread).toBe(1);
  }, 600_000);

  it('Sol proof, criterion 6: API.md names the status chat.send_direct and chat.mark_read answer for an invalid body or upTo', async () => {
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
  }, 600_000);
});
