// SPDX-License-Identifier: AGPL-3.0-only
//
// #1563: a retry of a message, from another process, at any point between its
// call's settlement and its reply's keep, never asks the model again and leaves
// the message one reply. The settlement keeps a transient copy of the answer;
// whichever keep takes the conversation's row first keeps the reply from it,
// and the other finds that reply. Each side runs on a connection of its own,
// stopped at a named statement, and the steps are ordered by what the database
// reports, never by a sleep. The copy goes with the reply it became, and with
// the conversation's body when that is purged, and only the conversation's
// owner can turn it into a reply.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { waitingOn } from '../support/lock-waits.ts';
import { detail, setConversationWindow } from './aw-03-fixture.ts';
import { localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import {
  epochWorld,
  ownerOn,
  stepped,
  type EpochWorld,
  type StepHow,
} from './conversation-epoch-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const SETTLE = 'select state from public.model_calls where business_id = $1 and id = $2 for update';
const LOCK = 'select body_purged_at from conversations';
const INSERT = 'insert into conversation_messages';

let c: EpochWorld;
/** Another process's exchange: its own in-flight map and its own model, never to be asked. */
let other: LocalModel;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('answer_copy_race');
  other = await localModel();
}, 180_000);

afterAll(async () => {
  await other?.close();
  await c?.drop();
});

interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

/** A conversation with one question in it and nothing answering yet. */
async function question(): Promise<Asked> {
  const started = await ownerOn(c, c.unanswered, 'conversation.start', {
    operationId: randomUUID(),
    body: `question-${randomUUID()}`,
  });
  const kept = detail(started);
  return { conversationId: String(kept['conversationId']), messageId: String(kept['messageId']) };
}

/** The retry, from the other process, on the world's own connection. */
const retried = async (asked: Asked) =>
  await other.exchange(c.fixture.db.app, c.fixture.business, c.w.owner.presented, asked);

/** Requests either model received. */
const asked = () => c.model.provider.seen.length + other.provider.seen.length;

async function rowsOf(messageId: string) {
  const { admin } = c.fixture.db;
  const replies = await admin.execute<{ readonly id: string }>(
    `select id::text from public.conversation_messages where answers_message_id = $1`,
    [messageId],
  );
  const calls = await admin.execute<{ readonly state: string }>(
    `select state from public.model_calls where conversation_message_id = $1`,
    [messageId],
  );
  const copies = await admin.execute(
    `select 1 from public.conversation_answer_copies where message_id = $1`,
    [messageId],
  );
  return {
    replies: replies.map((row) => row.id),
    calls: calls.map((row) => row.state),
    copies: copies.length,
  };
}

const STILL = { answered: false, code: 'STILL_ANSWERING' } as const;
const REPLY = { answered: true } as const;

/** When the retry comes, where the first exchange stops for it, and what the retry is told. */
const CASES = [
  ['before the settlement commits', SETTLE, 'hold-after', STILL],
  [
    'after the settlement commits, before the keep takes the conversation',
    LOCK,
    'hold-before',
    REPLY,
  ],
  ['while the keep holds the conversation, its reply not committed', INSERT, 'hold-after', REPLY],
] as const satisfies readonly (readonly [string, string, StepHow, object])[];

/** The first exchange stopped at `marker`, the retry run against it, and both answers. */
async function raced(q: Asked, marker: string, how: StepHow) {
  const step = stepped(c.fixture.db.appUrl, marker, how);
  try {
    const first = c.model.exchange(step.database, c.fixture.business, c.w.owner.presented, q);
    await step.reached;
    const again = retried(q);
    // While the keep holds the conversation's row the retry waits on it; else it is answered first.
    if (marker === INSERT) await waitingOn(c.fixture.db.admin, 'transactionid', LOCK);
    else await again;
    step.release();
    return [await first, await again] as const;
  } finally {
    await step.close();
  }
}

describe.skipIf(serverUrl === undefined)('a retry between settlement and keep', () => {
  it.each(CASES)(
    'a retry %s leaves one reply, and the model asked once',
    async (_when, marker, how, told) => {
      const q = await question();
      const before = asked();
      const answers = await raced(q, marker, how);
      expect(answers).toMatchObject([REPLY, told]);
      expect(asked()).toBe(before + 1);
      const rows = await rowsOf(q.messageId);
      expect(rows.replies).toHaveLength(1);
      const ids = answers.flatMap((answer) =>
        answer?.answered === true ? [answer.messageId] : [],
      );
      expect(new Set(ids)).toEqual(new Set(rows.replies));
      expect(rows.calls).toEqual(['settled']);
      expect(rows.copies).toBe(0);
    },
  );

  it('a retry after the keep commits is answered from the reply, the model not asked', async () => {
    const q = await question();
    const kept = await c.model.exchange(
      c.fixture.db.app,
      c.fixture.business,
      c.w.owner.presented,
      q,
    );
    expect(kept).toMatchObject({ answered: true });
    const before = asked();
    expect(await retried(q)).toMatchObject({ answered: true, body: kept?.answered && kept.body });
    expect(asked()).toBe(before);
    expect(await rowsOf(q.messageId)).toEqual({
      replies: [kept?.answered && kept.messageId],
      calls: ['settled'],
      copies: 0,
    });
  });
});

/** The question's exchange on a connection whose reply keep rolls back. */
async function rolledBack(q: Asked): Promise<void> {
  const step = stepped(c.fixture.db.appUrl, LOCK, 'fail-after');
  try {
    const replying = c.model.exchange(step.database, c.fixture.business, c.w.owner.presented, q);
    await expect(replying).rejects.toThrow(LOCK);
  } finally {
    await step.close();
  }
}

/** The conversation's body purged, a week's window over this world's work window passed. */
async function purgedBody(conversationId: string) {
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    const work = await writeBusinessSetting(tx, {
      key: 'retention_window_days',
      owningOperation: 'settings.set_retention_window',
      value: 30,
    });
    expect(work).not.toBeUndefined();
    await setConversationWindow(tx, 7);
  });
  await c.w.age(conversationId, 8);
  return await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    const wrapped = await writeWrapUp(tx, { conversationId, codeRevision: 'answer-copy' });
    expect(wrapped).toMatchObject({ ok: true });
    return await purgeConversation(tx, { conversationId, operationId: randomUUID() });
  });
}

describe.skipIf(serverUrl === undefined)('an answer copy whose reply rolled back', () => {
  it('becomes a reply for the conversation owner only', async () => {
    const q = await question();
    await rolledBack(q);
    expect((await rowsOf(q.messageId)).copies).toBe(1);
    const before = asked();
    const colleague = await other.exchange(
      c.fixture.db.app,
      c.fixture.business,
      c.w.colleague.presented,
      q,
    );
    expect(colleague).toBeNull();
    expect(await rowsOf(q.messageId)).toMatchObject({ replies: [], copies: 1 });
    expect(await retried(q)).toMatchObject({ answered: true });
    expect(asked()).toBe(before);
    expect(await rowsOf(q.messageId)).toMatchObject({ copies: 0 });
    expect((await rowsOf(q.messageId)).replies).toHaveLength(1);
  });

  it('goes with the conversation body when it is purged', async () => {
    const q = await question();
    await rolledBack(q);
    expect((await rowsOf(q.messageId)).copies).toBe(1);
    const purged = await purgedBody(q.conversationId);
    expect(purged).toStrictEqual({ ok: true, replayed: false, messagesPurged: 1 });
    expect(await rowsOf(q.messageId)).toMatchObject({ replies: [], copies: 0 });
    const before = asked();
    expect(await retried(q)).toBeNull();
    expect(asked()).toBe(before);
  });
});
