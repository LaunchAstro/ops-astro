// SPDX-License-Identifier: AGPL-3.0-only
//
// `contextOf` is the exported reader of a conversation's question, page and
// earlier messages. It judges the owner itself: another person in the business
// reads nothing and marks nothing. Its grant is held for share and judged
// after every wait, so a revocation that commits during a wait is seen and one
// that comes later waits for it; a refusal mark waits on the audit chain
// before that judgement, so no mark lands on a stale answer; and the question
// is read again with its earlier messages in one statement, so a purge is seen
// whole. Two connections where a step must run while another is held.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextOf,
  PAGE_TITLE_LIMIT,
  type OwnQuestion,
} from '../../packages/core-commands/src/commands/conversation-context.ts';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import {
  advisoryLock,
  connect,
  revokeGrant,
  withSession,
  writeBusinessSetting,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { latch } from '../support/lock-wait-race.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import {
  epochWorld,
  marksOf,
  openedOnTask,
  ownerOn,
  stepped,
  trashed,
  type EpochWorld,
  type Opened,
} from './conversation-epoch-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** `contextOf`'s first statement: the asked question, found as the caller's own. */
const QUESTION_FOUND = 'select c.owner_person_id, m.body, c.scope_record_id';
/** The page task's share lock in `pageOf`. */
const PAGE_HELD = 'deleted_at is null\n      for share';
/** The final read: the question again, with its earlier messages. */
const FINAL_READ = 'select q.body as question';

let c: EpochWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  c = await epochWorld('context_owner');
}, 180_000);

afterAll(async () => {
  await c?.drop();
});

interface Pending {
  readonly conversationId: string;
  readonly messageId: string;
  /** The first question, answered, so it rides in the next one's earlier messages. */
  readonly canary: string;
  readonly taskId: string | null;
  /** The task the conversation was opened on, as the trash command needs it. */
  readonly opened: Opened | null;
}

/** A conversation, on a task or on none: its first question answered, a second kept unanswered. */
async function pending(onTask: boolean): Promise<Pending> {
  let conversationId: string;
  let canary: string;
  let taskId: string | null = null;
  let opened: Opened | null = null;
  if (onTask) {
    opened = await openedOnTask(c);
    ({ conversationId, canary, taskId } = opened);
  } else {
    canary = `unscoped-${randomUUID()}`;
    const started = await c.w.as(c.w.owner, 'conversation.start', { body: canary });
    expect(started.body['reply']).toMatchObject({ answered: true });
    conversationId = String(detail(started)['conversationId']);
  }
  const kept = await ownerOn(c, c.unanswered, 'conversation.message', {
    operationId: randomUUID(),
    conversationId,
    body: `pending-${randomUUID()}`,
  });
  return {
    conversationId,
    messageId: String(detail(kept)['messageId']),
    canary,
    taskId,
    opened,
  };
}

/** `contextOf` in `who`'s own session; a refused session is a failed case, not an answer. */
async function contextAs(
  database: Database,
  who: Member,
  asked: Pending,
): Promise<OwnQuestion | undefined> {
  const read = await withSession(
    database,
    c.fixture.business,
    who.presented,
    async (tx, session) =>
      await contextOf(tx, session, {
        conversationId: asked.conversationId,
        messageId: asked.messageId,
      }),
  );
  if (read !== undefined && !('context' in read)) throw new Error(`session refused: ${read.code}`);
  return read;
}

/** The business's work retention window, in days. */
async function workWindow(tx: TenantQuery, days: number): Promise<void> {
  const written = await writeBusinessSetting(tx, {
    key: 'retention_window_days',
    owningOperation: 'settings.set_retention_window',
    value: days,
  });
  expect(written).not.toBeUndefined();
}

/**
 * Every grant `who` holds on `collection`, ended now through `revokeGrant`,
 * on a connection of its own, so it can wait on a lock while the case's other
 * connections go on.
 */
async function revokeAll(who: Member, collection: string): Promise<void> {
  const ids = await grantIdsOf(who, collection);
  const own = connect(c.fixture.db.appUrl);
  try {
    await own.withBusiness(c.fixture.business, async (tx) => await revokeEach(tx, ids));
  } finally {
    await own.close();
  }
}

/** The live grants `who` holds on `collection`. */
async function grantIdsOf(who: Member, collection: string): Promise<readonly string[]> {
  const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
    `select id::text from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = $3 and revoked_at is null`,
    [c.fixture.business, who.personId, collection],
  );
  return rows.map((row) => row.id);
}

async function revokeEach(tx: TenantQuery, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- one grant after another, in one transaction
    await revokeGrant(tx, id);
  }
}

/** The owner's conversations given back, for the cases after a revocation. */
async function regrantOwner(): Promise<void> {
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    await grantTo(tx, c.w.owner, 'write', undefined, false, 'conversation');
  });
}

/** Waits until a backend running a query that matches `pattern` is waiting on a lock. */
async function untilWaiting(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await c.fixture.db.admin.execute(
      `select 1 from pg_stat_activity
        where wait_event_type = 'Lock' and query ~ $1`,
      [pattern],
    );
    if (rows.length > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`nothing matching "${pattern}" ever waited on a lock`);
}

describe.skipIf(serverUrl === undefined)(
  'a conversation context is read only for its owner',
  () => {
    it("another person in the business reads none of the owner's conversation", async () => {
      const asked = await pending(true);
      const mine = await contextAs(c.fixture.db.app, c.w.owner, asked);
      expect(JSON.stringify(mine)).toContain(asked.canary);
      const theirs = await contextAs(c.fixture.db.app, c.w.colleague, asked);
      expect(theirs).toBeUndefined();
    });

    it("another person's call on a page they cannot read marks nothing, and the owner's answer is still sent", async () => {
      const asked = await pending(true);
      await revokeAll(c.w.colleague, 'task');
      expect(await contextAs(c.fixture.db.app, c.w.colleague, asked)).toBeUndefined();
      expect(await marksOf(c.fixture, asked.messageId)).toEqual([]);
      const seen = c.model.provider.seen.length;
      const reply = await c.model.exchange(
        c.fixture.db.app,
        c.fixture.business,
        c.w.owner.presented,
        {
          conversationId: asked.conversationId,
          messageId: asked.messageId,
        },
      );
      expect(reply).toMatchObject({ answered: true });
      expect(c.model.provider.seen).toHaveLength(seen + 1);
    });

    it('a purge committed after the question was found leaves no question and sends nothing', async () => {
      const asked = await pending(false);
      const read = stepped(c.fixture.db.appUrl, QUESTION_FOUND, 'hold-after');
      try {
        const seen = c.model.provider.seen.length;
        const replying = c.model.exchange(read.database, c.fixture.business, c.w.owner.presented, {
          conversationId: asked.conversationId,
          messageId: asked.messageId,
        });
        await read.reached;
        await c.w.age(asked.conversationId, 40);
        await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
          // The epoch world purges trash at once (window 0); a conversation purge reads a real window.
          await workWindow(tx, 30);
          expect(
            await writeWrapUp(tx, {
              conversationId: asked.conversationId,
              codeRevision: 'abc1234',
            }),
          ).toMatchObject({ ok: true });
          const purged = await purgeConversation(tx, {
            conversationId: asked.conversationId,
            operationId: randomUUID(),
          });
          expect(purged, JSON.stringify(purged)).toMatchObject({ ok: true });
        });
        read.release();
        expect(await replying).toBeNull();
        expect(c.model.provider.seen).toHaveLength(seen);
      } finally {
        await read.close();
        await c.fixture.db.app.withBusiness(
          c.fixture.business,
          async (tx) => await workWindow(tx, 0),
        );
      }
    });

    it('a page task of another record type is no page', async () => {
      const asked = await pending(false);
      const title = `not-a-task-${randomUUID()}`;
      const typeId = randomUUID();
      const recordId = randomUUID();
      const admin = c.fixture.db.admin;
      await admin.execute(
        `insert into public.record_types (business_id, id, key, name) values ($1, $2, 'note', 'Note')`,
        [c.fixture.business, typeId],
      );
      await admin.execute(
        `insert into public.records (business_id, id, record_type_id, txt_4) values ($1, $2, $3, $4)`,
        [c.fixture.business, recordId, typeId, title],
      );
      await admin.execute(
        `update public.conversations set scope_kind = 'task', scope_record_id = $2 where id = $1`,
        [asked.conversationId, recordId],
      );
      const read = await contextAs(c.fixture.db.app, c.w.owner, asked);
      expect(JSON.stringify(read)).not.toContain(title);
      expect(read?.context.refused).toBe(true);
    });

    it('a page title is cut by whole characters, never inside an emoji', async () => {
      const asked = await pending(true);
      const title = `${'a'.repeat(PAGE_TITLE_LIMIT - 1)}\u{1F600}tail`;
      // The slots are projected from `data`, so the title is written there.
      await c.fixture.db.admin.execute(
        `update public.records set data = jsonb_set(data, '{title}', to_jsonb($2::text)) where id = $1`,
        [asked.taskId, title],
      );
      const read = await contextAs(c.fixture.db.app, c.w.owner, asked);
      const page = read?.context.fields.find((field) => field.name === 'page');
      const sent = JSON.parse(page?.value ?? '{}') as { readonly title?: string };
      expect(sent.title).toBe(`${'a'.repeat(PAGE_TITLE_LIMIT - 1)}\u{1F600}`);
    });

    it("the owner's conversation grant ended while the page was waited on reads nothing, and one ended later waits", async () => {
      const before = await pending(true);
      const read = stepped(c.fixture.db.appUrl, PAGE_HELD, 'hold-after');
      try {
        const reading = contextAs(read.database, c.w.owner, before);
        await read.reached;
        await revokeAll(c.w.owner, 'conversation');
        read.release();
        expect(await reading).toBeUndefined();
        expect(await marksOf(c.fixture, before.messageId)).toEqual([]);
      } finally {
        await read.close();
        await regrantOwner();
      }
      const after = await pending(true);
      const held = stepped(c.fixture.db.appUrl, FINAL_READ, 'hold-before');
      try {
        const reading = contextAs(held.database, c.w.owner, after);
        await held.reached;
        const revoking = revokeAll(c.w.owner, 'conversation');
        await untilWaiting('update public.grants');
        held.release();
        expect(JSON.stringify(await reading)).toContain(after.canary);
        await revoking;
      } finally {
        await held.close();
        await regrantOwner();
      }
    });

    it("a refusal waiting on the audit chain while its holder ends the owner's grant writes no mark", async () => {
      const asked = await pending(true);
      // The page is in the trash: the read refuses it and would mark the question NOT_FOUND.
      if (asked.opened === null) throw new Error('the case needs a conversation on a task');
      await trashed(c, asked.opened);
      // The chain's holder ends the owner's grant in its own transaction, then commits.
      const ids = await grantIdsOf(c.w.owner, 'conversation');
      const chain = connect(c.fixture.db.appUrl);
      const taken = latch();
      const revokeNow = latch();
      const holding = chain.withBusiness(c.fixture.business, async (tx) => {
        await advisoryLock(tx, c.fixture.business.toLowerCase());
        taken.open();
        await revokeNow.promise;
        await revokeEach(tx, ids);
      });
      try {
        await taken.promise;
        const reading = contextAs(c.fixture.db.app, c.w.owner, asked);
        // At the chain: before the last judgement, or (were it taken late) inside the mark's own insert.
        await untilWaiting('pg_advisory_xact_lock|insert into audit_events');
        revokeNow.open();
        await holding;
        expect(await reading).toBeUndefined();
        expect(await marksOf(c.fixture, asked.messageId)).toEqual([]);
      } finally {
        revokeNow.open();
        await holding.catch(() => {});
        await chain.close();
        await regrantOwner();
      }
    });
  },
);
