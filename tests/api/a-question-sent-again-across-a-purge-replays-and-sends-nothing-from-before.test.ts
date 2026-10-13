// SPDX-License-Identifier: AGPL-3.0-only
//
// A question sent again with its operation id after its task's purge
// committed between the attempts. The replay keeps the stored outcome, the
// same message, and a later question carries nothing from before the purge:
// neither the question nor its answer, whether the answer was kept before the
// purge or only after it, when the first answer was lost.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import {
  epochsOf,
  epochWorld,
  openedOnTask,
  ownerOn,
  purgeOn,
  sentForNext,
  trashed,
  type EpochWorld,
  type Opened,
} from './conversation-epoch-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let c: EpochWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('question_retry_purge');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

/** The task trashed and purged between the attempts. */
async function purgedBetween(o: Opened): Promise<void> {
  await trashed(c, o);
  const purged = await purgeOn(c, c.w.api);
  expect(detail(purged)['purgedIds']).toContain(o.taskId);
}

const questionIn = (o: Opened) => ({
  operationId: randomUUID(),
  conversationId: o.conversationId,
  body: `asked-${randomUUID()}`,
});

describe.skipIf(serverUrl === undefined)('a question sent again across a purge', () => {
  it('a question answered before the purge, sent again after it, replays its message and answer and asks no model', async () => {
    const o = await openedOnTask(c);
    const sent = questionIn(o);
    const first = await ownerOn(c, c.w.api, 'conversation.message', sent);
    const reply = first.body['reply'] as { readonly messageId: string; readonly body: string };
    expect(reply).toMatchObject({ answered: true });
    await purgedBetween(o);
    const seen = c.model.provider.seen.length;
    const again = await ownerOn(c, c.w.api, 'conversation.message', sent);
    expect(detail(again)['messageId']).toBe(detail(first)['messageId']);
    expect(again.body['reply']).toMatchObject({ messageId: reply.messageId, body: reply.body });
    expect(c.model.provider.seen).toHaveLength(seen);
    const kept = await epochsOf(c.fixture, o.conversationId);
    expect(kept.messages.filter((m) => m.body === sent.body)).toHaveLength(1);
    const next = await sentForNext(c, o.conversationId);
    for (const before of [o.canary, sent.body, reply.body]) expect(next).not.toContain(before);
  });

  it('a question whose answer was lost before the purge, sent again after it, is answered with nothing from before and cut after', async () => {
    const o = await openedOnTask(c);
    const sent = questionIn(o);
    const first = await ownerOn(c, c.unanswered, 'conversation.message', sent);
    const messageId = String(detail(first)['messageId']);
    await purgedBetween(o);
    const again = await ownerOn(c, c.w.api, 'conversation.message', sent);
    expect(detail(again)['messageId']).toBe(messageId);
    const reply = again.body['reply'] as { readonly body: string };
    expect(reply).toMatchObject({ answered: true });
    // The question itself is asked; nothing said before it, and no page, goes with it.
    const asked = c.model.provider.seen.at(-1)?.body ?? '';
    expect(asked).toContain(sent.body);
    expect(asked).not.toContain(o.canary);
    expect(asked).not.toContain('task to be purged');
    const kept = await epochsOf(c.fixture, o.conversationId);
    const question = kept.messages.find((m) => m.id === messageId);
    const answer = kept.messages.find((m) => m.answers === messageId);
    expect([question?.epoch, answer?.epoch, kept.epoch]).toEqual([0, 1, 1]);
    const next = await sentForNext(c, o.conversationId);
    for (const before of [o.canary, sent.body, reply.body]) expect(next).not.toContain(before);
  });
});
