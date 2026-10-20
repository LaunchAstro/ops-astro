// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines -- every refusing change at each of three moments, in one world */
//
// The answer's pieces are heard under the authority its reply is kept under.
// Each refusing change commits on a connection of its own while Ollama writes
// a streamed answer: a grant revoked, the session signed out, the body purged,
// and the person's access ended (membership, actor and grants together). Each
// is committed
//
// (a) before the first batch is judged (Ollama holds the whole answer),
// (b) while a judgement holds the conversation's row and waits on its next
//     lock (the waits are seen in `pg_stat_activity`, never assumed), and
// (c) between two batches (the first batch's judgement has committed).
//
// No piece is handed on after the change commits, no reply is kept, and
// nothing waits for ever: the exchange answers on a one-connection pool, the
// pool the judgements and the settle share.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  purgeConversation,
  writeWrapUp,
  type ConversationReply,
} from '../../packages/core-commands/src/index.ts';
import {
  advisoryLock,
  revokeGrant,
  type TenantQuery,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { subjectKey } from '../../packages/core-records/src/identity/ending-keys.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch, waiterOf, type Held } from '../support/lock-wait-race.ts';
import {
  CODE_REVISION,
  CONVERSATION,
  conversationWorld,
  detail,
  setConversationWindow,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Alpha ', 'Bravo ', 'Charlie ', 'Delta.'] as const;
const FIRST_BATCH = 'Alpha Bravo ';

type Change = 'revoke' | 'sign-out' | 'purge' | 'access-end';

interface Asker {
  readonly member: Member;
  readonly presented: VerifiedSubject;
  readonly sessionId: string;
  readonly asked: { readonly conversationId: string; readonly messageId: string };
}

/** Until the pieces handed on so far spell `text`. */
async function heard(events: readonly string[], text: string): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    const spelt = events
      .filter((event) => event.startsWith('piece:'))
      .map((event) => event.slice(6))
      .join('');
    if (spelt === text) return;
    // oxlint-disable-next-line no-await-in-loop -- polls the pieces
    await sleep(10);
  }
  throw new Error(`the pieces never spelt ${JSON.stringify(text)}: ${JSON.stringify(events)}`);
}

// eslint-disable-next-line max-lines-per-function -- one stand-in, one broker, every schedule
describe.skipIf(serverUrl === undefined)('no piece after a refusing change commits', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;
  let other: Database;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('pieces_refusing_change');
    // The API answers nothing; each case calls the exchange on a pool of its own.
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await setConversationWindow(tx, 7);
      // The owner ends a person's access as a manager does (C58).
      await grantTo(tx, w.owner, 'manage', undefined, false, 'access');
    });
    other = connect(fixture.db.appUrl, { source: 'runtime' });
  }, 180_000);

  afterAll(async () => {
    await other?.close();
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const on = async <T>(database: Database, work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await database.withBusiness(w.fixture.business, work);

  /** A fresh member holding their own conversations, a question kept, due for purge if asked. */
  async function asker(change: Change): Promise<Asker> {
    const member = await enrol(w.fixture.db.app, w.fixture.business, `asker-${change}`);
    await on(w.fixture.db.app, async (tx) => {
      await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
    });
    const opened = await w.as(member, 'conversation.start', { body: `Question for ${change}` });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    if (change === 'purge') {
      await w.age(asked.conversationId, 8);
      const wrapped = await on(
        w.fixture.db.app,
        async (tx) =>
          await writeWrapUp(tx, {
            conversationId: asked.conversationId,
            codeRevision: CODE_REVISION,
          }),
      );
      expect(wrapped).toMatchObject({ ok: true });
    }
    const sessionId = randomUUID();
    return { member, presented: { ...member.presented, sessionId }, sessionId, asked };
  }

  /** The change, committed on its own connection (the API's for an access ending). */
  async function commit(change: Change, who: Asker): Promise<void> {
    if (change === 'revoke') {
      await on(other, async (tx) => {
        const grants = await tx.query<{ id: string }>(
          `select id from public.grants where subject_id = $1 and collection = 'conversation'
              and revoked_at is null`,
          [who.member.personId],
        );
        expect(grants.length).toBeGreaterThan(0);
        // oxlint-disable-next-line no-await-in-loop -- one revocation after another
        for (const grant of grants) expect(await revokeGrant(tx, grant.id)).not.toBeNull();
      });
      return;
    }
    if (change === 'sign-out') {
      const signedOut = await on(
        other,
        async (tx) => await endOwnSession(tx, who.member.personId, who.sessionId),
      );
      expect(signedOut).toBe(1);
      return;
    }
    if (change === 'purge') {
      const purged = await on(
        other,
        async (tx) =>
          await purgeConversation(tx, {
            conversationId: who.asked.conversationId,
            operationId: randomUUID(),
          }),
      );
      expect(purged).toMatchObject({ ok: true, replayed: false });
      return;
    }
    const access = await w.as(w.owner, 'access.end', {
      operationId: randomUUID(),
      holderId: who.member.personId,
    });
    expect(access.status).toBe(200);
  }

  /** A transaction on a connection of its own, kept open after `work` until `letGo`. */
  async function heldOpen(work: (tx: TenantQuery) => Promise<void>): Promise<Held> {
    const own = connect(w.fixture.db.appUrl, { source: 'runtime' });
    const go = latch();
    const ready = latch<number>();
    const done = on(own, async (tx) => {
      await work(tx);
      const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      ready.open(Number(me?.pid));
      await go.promise;
    });
    const pid = await Promise.race([ready.promise, done.then(() => -1)]);
    if (pid === -1) throw new Error('the holder ended before it held its lock');
    let gone = false;
    return {
      pid,
      letGo: async () => {
        if (gone) return;
        gone = true;
        go.open();
        try {
          await done;
        } finally {
          await own.close();
        }
      },
    };
  }

  /** Until `n` backends of this database wait on a lock. */
  async function lockWaiters(n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const found = await w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (found >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    throw new Error(`${String(n)} backends never waited on a lock`);
  }

  /** Until the person's membership is seen ended, committed. */
  async function ended(personId: string): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const live = await w.count(
        `select count(*)::text as n from public.memberships where person_id = $1 and active`,
        [personId],
      );
      if (live === 0) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    throw new Error('the access ending never committed');
  }

  const replies = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  /** What every schedule ends on: no piece after the change, no reply kept, an answer given. */
  async function refusedAfter(
    events: readonly string[],
    who: Asker,
    reply: ConversationReply | null,
  ): Promise<void> {
    const changed = events.indexOf('change');
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(events.slice(changed + 1).filter((event) => event.startsWith('piece:'))).toEqual([]);
    expect(reply === null || reply.answered === false).toBe(true);
    expect(await replies(who.asked.conversationId)).toBe(0);
  }

  const kinds: readonly Change[] = ['revoke', 'sign-out', 'purge', 'access-end'];

  // oxlint-disable-next-line max-lines-per-function -- one schedule per moment, for each change
  describe.each(kinds)('%s', (change) => {
    it('(a) committed before the first batch is judged: no piece at all', async () => {
      const who = await asker(change);
      const before = ollama.seen.length;
      ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
      const reader = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const events: string[] = [];
      ollama.shut();
      try {
        const answering = broker.exchange(
          reader,
          w.fixture.business,
          who.presented,
          who.asked,
          (text) => events.push(`piece:${text}`),
        );
        await ollama.arrived(before + 1);
        await commit(change, who);
        events.push('change');
        ollama.open();
        const reply = await answering;
        await refusedAfter(events, who, reply);
        expect(events).toEqual(['change']);
      } finally {
        ollama.open();
        await reader.close();
      }
    }, 60_000);

    // oxlint-disable-next-line max-lines-per-function -- the holder, the wait and the change in order
    it('(b) committed while a judgement holds the conversation row and waits on its next lock', async () => {
      const who = await asker(change);
      const before = ollama.seen.length;
      ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
      const reader = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const events: string[] = [];
      let holder: Held | undefined;
      let changing: Promise<void> | undefined;
      ollama.shut();
      try {
        const answering = broker.exchange(
          reader,
          w.fixture.business,
          who.presented,
          who.asked,
          (text) => events.push(`piece:${text}`),
        );
        await ollama.arrived(before + 1);
        if (change === 'sign-out') {
          // The sign-out itself is the holder: its session key taken, not yet committed.
          holder = await heldOpen(async (tx) => {
            expect(await endOwnSession(tx, who.member.personId, who.sessionId)).toBe(1);
          });
        } else {
          // An ending of this subject in flight: the judgement, past the
          // conversation row, waits on the subject's key.
          holder = await heldOpen(async (tx) => {
            await advisoryLock(tx, subjectKey(who.member.presented.subject));
          });
        }
        ollama.open();
        await waiterOf(w.fixture.db, holder);
        if (change === 'sign-out') {
          await holder.letGo();
          events.push('change');
        } else if (change === 'purge') {
          // The purge wants the row for update: it waits behind the judgement's share lock.
          changing = (async () => {
            await commit(change, who);
            events.push('change');
          })();
          await lockWaiters(2);
          await holder.letGo();
          await changing;
        } else if (change === 'access-end') {
          // The act commits first; the provider steps after it may queue on the
          // subject's key, so its commit is read from the membership row.
          changing = commit(change, who);
          await ended(who.member.personId);
          events.push('change');
          await holder.letGo();
          await changing;
        } else {
          await commit(change, who);
          events.push('change');
          await holder.letGo();
        }
        const reply = await answering;
        await refusedAfter(events, who, reply);
        if (change !== 'purge') {
          expect(events.filter((event) => event.startsWith('piece:'))).toEqual([]);
        }
      } finally {
        ollama.open();
        await holder?.letGo();
        await changing?.catch(() => {});
        await reader.close();
      }
    }, 60_000);

    it('(c) committed between two batches: the first is heard, nothing after', async () => {
      const who = await asker(change);
      ollama.reply = (model) => ({
        status: 200,
        chunks: streamedLines(model, WORDS),
        holdAfter: 2,
      });
      const reader = connect(w.fixture.db.appUrl, { source: 'runtime' });
      const events: string[] = [];
      try {
        const answering = broker.exchange(
          reader,
          w.fixture.business,
          who.presented,
          who.asked,
          (text) => events.push(`piece:${text}`),
        );
        await ollama.midway();
        await heard(events, FIRST_BATCH);
        // The reader's one connection is free only once the first judgement has committed.
        await on(reader, async () => await Promise.resolve());
        await commit(change, who);
        events.push('change');
        ollama.resume();
        const reply = await answering;
        await refusedAfter(events, who, reply);
        expect(
          events
            .filter((event) => event.startsWith('piece:'))
            .map((event) => event.slice(6))
            .join(''),
        ).toBe(FIRST_BATCH);
      } finally {
        ollama.resume();
        await reader.close();
      }
    }, 60_000);
  });
});
