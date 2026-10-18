// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat: `chat.mark_read` naming its conversation in upper case takes the
// same conversation lock a send holds, so it waits for the send rather than
// slipping past under another spelling of the key. The send is paused at its
// message write on a connection of its own; the reader marks the conversation
// read up to a time past now (clamped to the clock read under the lock), is
// seen waiting on the lower-case key in pg_locks, and once the send commits,
// its marker counts the message: nothing is left unread.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../acceptance/cast.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pausedCommand, tracked, waitsOn, writesMessage } from './chat-paused-command-world.ts';
import { idOf } from './c71-d-lock-world.ts';
import { createGroupWorld, type GroupWorld } from './c71-g-world.ts';

type Send = 'chat.send_direct' | 'chat.send_group';

/** The conversation Mia sends into, and who marks it read. */
async function sceneFor(g: GroupWorld, send: Send) {
  const { world } = g.chat.harness;
  if (send === 'chat.send_group') {
    return {
      reader: world.ada as Caller,
      conversationId: g.conversationId,
      fields: (body: string) => ({ conversationId: g.conversationId, body }),
    };
  }
  const opening = await g.chat.send(world.mia, g.chat.tess, 'an opening direct message');
  expect(opening.status, opening.text).toBe(200);
  return {
    reader: g.chat.tess,
    conversationId: idOf(opening),
    fields: (body: string) => ({ teammateId: g.chat.tess.personId, body }),
  };
}

async function markAcrossSend(g: GroupWorld, send: Send) {
  const { world } = g.chat.harness;
  const { reader, conversationId, fields } = await sceneFor(g, send);
  const body = `marked-across-${randomUUID()}`;
  const paused = pausedCommand(
    world.db.appUrl,
    world.alpha,
    world.mia.presented,
    { command: send, ...fields(body) },
    { at: writesMessage(body), when: 'before' },
  );
  try {
    await paused.reached;
    const marking = tracked(
      g.as(reader, 'chat.mark_read', {
        conversationId: conversationId.toUpperCase(),
        upTo: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const markWaited = await waitsOn(
      world.db.admin,
      `chat.conversation:${world.alpha}:${conversationId.toLowerCase()}`,
      'exclusive',
      marking.done,
    );
    paused.release();
    const sent = await paused.result;
    const marked = await marking.value;
    const view = await g.viewOf(reader, conversationId);
    return {
      markWaited,
      sent: sent['refused'] === true ? String(sent['code']) : 'applied',
      marked: marked.code,
      read: (await g.bodiesOf(reader, conversationId)).includes(body),
      unread: view?.unread,
    };
  } finally {
    await paused.settle();
  }
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a mark read naming its conversation in upper case',
  () => {
    let g: GroupWorld;
    beforeAll(async () => {
      g = await createGroupWorld('chatmarkcase');
    }, 600_000);
    afterAll(async () => {
      await g?.chat.harness.close();
    });

    it.each<Send>(['chat.send_direct', 'chat.send_group'])(
      'waits on the conversation lock %s holds and its marker counts the message the send commits',
      async (send) => {
        expect(await markAcrossSend(g, send)).toEqual({
          markWaited: true,
          sent: 'applied',
          marked: 'ok',
          read: true,
          unread: 0,
        });
      },
      60_000,
    );
  },
);
