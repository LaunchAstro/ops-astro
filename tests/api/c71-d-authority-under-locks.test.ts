// SPDX-License-Identifier: AGPL-3.0-only
// C71-D direct messages under concurrent change: authority read after the
// lock waits, read order within one millisecond, and the seeded member bundle.
// oxlint-disable no-await-in-loop -- clock steps and held-lock interleavings are sequential.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  listConversations,
  moveReadMarker,
  readConversationTypes,
  writeComment,
} from '../../packages/core-records/src/index.ts';
import type { ChatConversationView, ChatMessageView } from '../../packages/core-wire/src/index.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';

const CHAT = { membership: true, actions: ['comment'], collections: ['chat'] } as const;

function seededMemberPairs(): readonly (readonly [string, Action])[] {
  // Same source-data reader as seeded-role-grants.test.ts. The seed runs on
  // import, so evaluate its constant table alone and validate the result.
  const source = readFileSync('scripts/local-seed.mjs', 'utf8');
  const prefix = 'const GRANTS_BY_ROLE = ';
  const start = source.indexOf(`${prefix}{`);
  const end = source.indexOf('\n};\n', start);
  if (start < 0 || end < 0) throw new Error('seed grant table absent');
  const value: unknown = new Function(
    `return (${source.slice(start + prefix.length, end + 2)});`,
  )();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('member' in value) ||
    !Array.isArray(value.member)
  ) {
    throw new Error('seed member bundle malformed');
  }
  return value.member.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('seed pair malformed');
    const collection: unknown = entry[0];
    const action: unknown = entry[1];
    if (typeof collection !== 'string' || !isAction(action)) throw new Error('seed pair invalid');
    return [collection, action] as const;
  });
}

function isAction(value: unknown): value is Action {
  return (
    typeof value === 'string' &&
    ['read', 'comment', 'write', 'assign', 'decide', 'share', 'manage'].includes(value)
  );
}

function idOf(answer: Answer): string {
  const detail = answer.body['detail'];
  if (typeof detail !== 'object' || detail === null || !('conversationId' in detail)) {
    throw new Error(`no conversation in ${answer.text}`);
  }
  return String(detail.conversationId);
}

function noop(): void {}

function signal() {
  let fire: () => void = noop;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

async function waitForAdvisoryWait(chat: ChatWorld): Promise<void> {
  const { db } = chat.harness.world;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // This observes a real blocked server statement, rather than guessing a delay.
    const rows = await db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where usename = $1 and wait_event = 'advisory'
          and query like 'select pg_advisory_xact_lock%'`,
      [db.loginRole],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('write never reached the held advisory lock');
}

async function writeAcrossChange(
  chat: ChatWorld,
  lockKey: string,
  invoke: () => Promise<Answer>,
  change: () => Promise<void>,
): Promise<Answer> {
  const { world } = chat.harness;
  const own = connect(world.db.appUrl);
  const held = signal();
  const release = signal();
  const holding = own.withBusiness(world.alpha, async (tx) => {
    await advisoryLock(tx, lockKey);
    held.fire();
    await release.fired;
  });
  await held.fired;
  const sending = invoke();
  try {
    await waitForAdvisoryWait(chat);
    await change();
  } finally {
    release.fire();
    await holding;
    await own.close();
  }
  return await sending;
}

async function sendAcrossChange(
  chat: ChatWorld,
  from: Caller,
  to: Caller,
  body: string,
  change: () => Promise<void>,
): Promise<Answer> {
  const pair = [from.personId, to.personId].toSorted().join(':');
  return await writeAcrossChange(
    chat,
    `chat.direct:${chat.harness.world.alpha}:${pair}`,
    async () => await chat.send(from, to, body),
    change,
  );
}

describe('C71-D direct messages under concurrent change', () => {
  let chat: ChatWorld;
  beforeAll(async () => {
    chat = await createChatWorld('solc71review');
  }, 600_000);
  afterAll(async () => {
    await chat?.harness.close();
  });

  it('criterion 5: marking the first of two messages in one millisecond leaves the unseen second unread', async () => {
    const { world } = chat.harness;
    const to = await enrolCaller(world.db, world.alpha, 'alpha', 'tie-reader', CHAT);
    const first = await chat.send(world.ada, to, 'seen first');
    expect(first.status, first.text).toBe(200);
    const conversationId = idOf(first);
    const snapshot = await chat.as(to, 'chat.messages', { conversationId });
    const seen = (snapshot.body['messages'] as ChatMessageView[])[0];
    if (seen === undefined) throw new Error('first message absent');
    const second = await chat.send(world.ada, to, 'unseen second');
    expect(second.status, second.text).toBe(200);
    // A deterministic fixture for the precision the production writer stores.
    // The reader's snapshot predates the second message. Both timestamps are
    // valid output of CLOCK_TEXT, which retains milliseconds only.
    await world.db.admin.execute(
      `update public.records set data = jsonb_set(data, '{posted_at}', to_jsonb($2::text))
        where id = $1`,
      [(second.body['detail'] as Record<string, unknown>)['commentId'], seen.at],
    );
    const marked = await chat.as(to, 'chat.mark_read', { conversationId, upTo: seen.at });
    expect(marked.status, marked.text).toBe(200);
    const listed = await chat.as(to, 'chat.conversations');
    const view = (listed.body['conversations'] as ChatConversationView[]).find(
      (row) => row.conversationId === conversationId,
    );
    expect(view?.unread, 'the second message was absent from the marked snapshot').toBe(1);
  });

  it('criterion 5: a real message written after a read marker remains unread when both wall clocks fall in one millisecond', async () => {
    const { world } = chat.harness;
    const to = await enrolCaller(world.db, world.alpha, 'alpha', 'real-clock-reader', CHAT);
    const opening = await chat.send(world.ada, to, 'before the clock collision');
    expect(opening.status, opening.text).toBe(200);
    const conversationId = idOf(opening);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const types = await readConversationTypes(tx);
      if (types === undefined || to.personId === null || world.ada.actorId === null) {
        throw new Error('clock proof identities absent');
      }
      // Exercise the real production marker and writer under their actual
      // conversation lock. No timestamp is rewritten or clock stubbed. Each
      // iteration marks all previous messages before the next one is written.
      for (let attempt = 0; attempt < 500; attempt += 1) {
        await moveReadMarker(tx, conversationId, to.personId, 'now');
        const commentId = await writeComment(tx, types.commentTypeId, {
          taskId: null,
          conversationId,
          authorActorId: world.ada.actorId,
          commentType: 'note',
          audience: 'direct',
          body: 'written after the marker',
          source: 'app',
        });
        const rows = await tx.query<{ readonly collided: boolean }>(
          `select c.ts_1 = m.last_read_at as collided from public.records c
             join public.team_conversation_members m
               on m.business_id = c.business_id and m.conversation_id = c.uuid_4
            where c.business_id = $1 and c.id = $2 and m.person_id = $3`,
          [world.alpha, commentId, to.personId],
        );
        if (rows[0]?.collided === true) {
          const views = await listConversations(tx, types, to.personId);
          expect(views.find((view) => view.conversationId === conversationId)?.unread).toBe(1);
          return;
        }
      }
      throw new Error('no real millisecond collision observed in 500 serial marker/message pairs');
    });
  });

  it('criterion 3: blocked chat writes cannot commit after their grant or membership revocation commits', async () => {
    const { world } = chat.harness;
    const outcomes: { code: string; stores: readonly string[]; nextRead: string }[] = [];
    for (const revoke of ['grant', 'membership']) {
      const from = await enrolCaller(world.db, world.alpha, 'alpha', `revoked-${revoke}`, CHAT);
      const body = `revoked-${revoke}-send-${randomUUID()}`;
      const answer = await sendAcrossChange(chat, from, world.mia, body, async () => {
        const rows = await world.db.admin.execute(
          revoke === 'grant'
            ? `update public.grants set revoked_at = greatest(now(), granted_at)
          where business_id = $1 and subject_id = $2 and collection = 'chat'
            and action = 'comment' and revoked_at is null returning id`
            : `update public.memberships set active = false, ended_at = now()
                where business_id = $1 and person_id = $2 and active returning id`,
          [world.alpha, from.personId],
        );
        expect(rows).toHaveLength(1);
      });
      outcomes.push({
        code: answer.code,
        stores: await chat.holding(body),
        nextRead: (await chat.as(from, 'chat.conversations')).code,
      });
    }
    const reader = await enrolCaller(world.db, world.alpha, 'alpha', 'revoked-reader', CHAT);
    const opening = await chat.send(world.ada, reader, 'unread before reader access ended');
    expect(opening.status, opening.text).toBe(200);
    const conversationId = idOf(opening);
    const marked = await writeAcrossChange(
      chat,
      `chat.conversation:${world.alpha}:${conversationId}`,
      async () =>
        await chat.as(reader, 'chat.mark_read', {
          conversationId,
          upTo: new Date().toISOString(),
        }),
      async () => {
        const rows = await world.db.admin.execute(
          `update public.memberships set active = false, ended_at = now()
            where business_id = $1 and person_id = $2 and active returning id`,
          [world.alpha, reader.personId],
        );
        expect(rows).toHaveLength(1);
      },
    );
    const markers = await world.db.admin.execute<{ readonly moved: boolean }>(
      `select last_read_at is not null as moved from public.team_conversation_members
        where business_id = $1 and conversation_id = $2 and person_id = $3`,
      [world.alpha, conversationId, reader.personId],
    );
    outcomes.push({
      code: marked.code,
      stores: markers[0]?.moved === true ? ['public.team_conversation_members'] : [],
      nextRead: (await chat.as(reader, 'chat.conversations')).code,
    });
    expect(outcomes).toEqual([
      { code: 'SCOPE_NOT_GRANTED', stores: [], nextRead: 'SCOPE_NOT_GRANTED' },
      { code: 'AUTH_NO_MEMBERSHIP', stores: [], nextRead: 'AUTH_NO_MEMBERSHIP' },
      { code: 'AUTH_NO_MEMBERSHIP', stores: [], nextRead: 'AUTH_NO_MEMBERSHIP' },
    ]);
  });

  it('criterion 5: a send waiting on the pair lock cannot add a recipient whose staff membership has ended', async () => {
    const { world } = chat.harness;
    const to = await enrolCaller(world.db, world.alpha, 'alpha', 'ended-recipient', CHAT);
    const body = `ended-recipient-${randomUUID()}`;
    const answer = await sendAcrossChange(chat, world.ada, to, body, async () => {
      const rows = await world.db.admin.execute(
        `update public.memberships set active = false, ended_at = now()
          where business_id = $1 and person_id = $2 and active returning id`,
        [world.alpha, to.personId],
      );
      expect(rows).toHaveLength(1);
    });
    expect({ code: answer.code, stores: await chat.holding(body) }, answer.text).toEqual({
      code: 'NOT_FOUND',
      stores: [],
    });
  });

  it('criterion 5: retrying one send operation creates one message and replays the same identifiers', async () => {
    const { world } = chat.harness;
    const operationId = randomUUID();
    const body = { operationId, teammateId: chat.tess.personId, body: 'one retried message' };
    const one = await chat.as(world.ada, 'chat.send_direct', body);
    const two = await chat.as(world.ada, 'chat.send_direct', body);
    expect(one.status, one.text).toBe(200);
    expect(two.body).toEqual(one.body);
    const messages = await chat.as(chat.tess, 'chat.messages', { conversationId: idOf(one) });
    expect(
      (messages.body['messages'] as ChatMessageView[]).filter(
        (message) => message.body === body.body,
      ),
    ).toHaveLength(1);
  });

  it('criterion 2: person to person, an administrator cannot read or list another pair conversation', async () => {
    const { world } = chat.harness;
    const sent = await chat.send(world.mia, chat.tess, 'a pair excluding the administrator');
    expect(sent.status, sent.text).toBe(200);
    const conversationId = idOf(sent);
    expect((await chat.as(world.ada, 'chat.messages', { conversationId })).code).toBe('NOT_FOUND');
    const listed = await chat.as(world.ada, 'chat.conversations');
    expect(
      (listed.body['conversations'] as ChatConversationView[]).some(
        (conversation) => conversation.conversationId === conversationId,
      ),
    ).toBe(false);
  });

  it('criterion 1: a seeded agency member can read and reply to a direct message without a manual grant top-up', async () => {
    const { world } = chat.harness;
    const member = await enrolCaller(world.db, world.alpha, 'alpha', 'seeded-member', {
      membership: true,
      actions: [],
      collections: [],
      extraPairs: seededMemberPairs(),
    });
    const sent = await chat.send(world.ada, member, 'a real default bundle must reach this');
    expect(sent.status, sent.text).toBe(200);
    const conversationId = idOf(sent);
    const listed = await chat.as(member, 'chat.conversations');
    const messages = await chat.as(member, 'chat.messages', { conversationId });
    const replied = await chat.send(member, world.ada, 'reply using the default bundle');
    expect(
      [listed.status, messages.status, replied.status],
      [listed.text, messages.text, replied.text].join('\n'),
    ).toEqual([200, 200, 200]);
  });
});
