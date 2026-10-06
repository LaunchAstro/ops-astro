// SPDX-License-Identifier: AGPL-3.0-only
//
// The keep of a question on a page task (`conversation.start` citing it,
// `conversation.message` in a conversation scoped to it) reads the task's
// client under a share lock, so a question kept while its page is a client's
// is marked refused (owner line 72). Two timing rules hold that read in place
// (Sol PRV-oa-1088-SC1):
//
// - SC1.1: a person whose read of the task was revoked is not let read or
//   lock it. Their message is kept and marked refused at once, without
//   waiting behind the task's writer.
//   The mark names why: SCOPE_NOT_GRANTED, not a client's refusal.
// - SC1.2: the share lock is taken before the `conversation:write` grant is
//   asked at the instant after it, so a grant that runs out while the keep
//   waits on the task no longer counts: the keep is refused and keeps nothing.
// - SEC1-1: so is the audit chain's lock, the last wait: a grant ended by a
//   writer that holds the chain when the keep reaches it no longer counts.
//
// The task row is held on another connection (`for update`, or `for no key
// update` as an ordinary task write takes it, which the citing start's
// foreign-key lock passes but the share lock waits on); the keep is seen
// waiting on that holder with its transaction begun before the expiry, and
// the holder lets go once the database clock is past it.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, hold, holdRow, waiterOf, waitPast } from '../support/lock-wait-race.ts';
import {
  CONVERSATION,
  conversationWorld,
  detail,
  expiringSoon,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import type { Answer } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const PERSON_MESSAGES = `select count(*) as n from public.conversation_messages
  where conversation_id = $1 and role = 'person'`;
const CITING = 'select count(*) as n from public.conversations where scope_record_id = $1';
const MARKED = `select count(*) as n from public.audit_events
  where command = 'model.call_refused' and refusal_code = $2 and attempted ->> 'messageId' = $1`;

// eslint-disable-next-line max-lines-per-function -- one world and its five cases
describe.skipIf(serverUrl === undefined)('a question kept on a held page task', () => {
  let w: ConversationWorld;

  beforeAll(async () => {
    w = await conversationWorld('keep_page_wait');
  }, 180_000);

  afterAll(async () => {
    await w?.drop();
  });

  async function task(title: string): Promise<string> {
    const made = await w.as(w.owner, 'task.create', { fields: { title } });
    return String(made.body['recordId']);
  }

  it('SC1.1: a message asked after its page read was revoked is kept and marked refused without waiting on the task', async () => {
    const { db, business } = w.fixture;
    const taskId = await task(`Held ${randomUUID()}`);
    const person = await enrol(db.app, business, `revoked-${randomUUID().slice(0, 8)}`);
    const grant = await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, person, 'write', undefined, false, CONVERSATION);
      return await grantTo(tx, person, 'read', { kind: 'record', id: taskId });
    });
    const opened = await w.as(person, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
    });
    const conversationId = String(detail(opened)['conversationId']);
    await db.app.withBusiness(business, async (tx) => await revokeGrant(tx, grant));
    const held = await holdRow(db, 'select id from public.records where id = $1 for update', [
      taskId,
    ]);
    const sending = w.as(person, 'conversation.message', { conversationId, body: 'and now?' });
    try {
      // Still holding the row: a keep that waited on it would lose this race.
      const answer = await Promise.race([sending, sleep(5_000).then(() => 'waited' as const)]);
      expect(answer === 'waited' ? answer : answer.status).toBe(200);
    } finally {
      await held.letGo();
    }
    const messageId = String(detail(await sending)['messageId']);
    expect(await w.count(PERSON_MESSAGES, [conversationId])).toBe(2);
    expect(await w.count(MARKED, [messageId, 'SCOPE_NOT_GRANTED'])).toBe(1);
  }, 30_000);

  it('SC1.2: a message whose conversation:write grant expires while it waits on its page task is refused and keeps nothing', async () => {
    const { db } = w.fixture;
    const taskId = await task(`Messaged across an expiry ${randomUUID()}`);
    const opened = await w.as(w.colleague, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
    });
    const conversationId = String(detail(opened)['conversationId']);
    const grant = await expiringSoon(w, w.colleague.personId, CONVERSATION, 'write');
    const held = await holdRow(db, 'select id from public.records where id = $1 for update', [
      taskId,
    ]);
    const sending = w.as(w.colleague, 'conversation.message', {
      conversationId,
      body: 'Sent across the expiry',
    });
    let startedLive = false;
    try {
      startedLive = await blockedBefore(db, held, grant.expiry);
      await waitPast(db, grant.expiry);
    } finally {
      await held.letGo();
    }
    const answer = await sending;
    await db.admin.execute('update public.grants set expires_at = null where id = $1', [grant.id]);
    expect({
      startedLive,
      status: answer.status,
      code: answer.body['code'],
      kept: await w.count(PERSON_MESSAGES, [conversationId]),
    }).toEqual({ startedLive: true, status: 403, code: 'SCOPE_NOT_GRANTED', kept: 1 });
  }, 30_000);

  it('SC1.2: a start whose conversation:write grant expires while it waits to read its page task under share is refused and keeps nothing', async () => {
    const { db } = w.fixture;
    const taskId = await task(`Started across an expiry ${randomUUID()}`);
    const grant = await expiringSoon(w, w.colleague.personId, CONVERSATION, 'write');
    // An ordinary task write's lock: the scope's foreign key passes it, the share lock waits.
    const held = await holdRow(
      db,
      'select id from public.records where id = $1 for no key update',
      [taskId],
    );
    const starting = w.as(w.colleague, 'conversation.start', {
      body: 'Sent across the expiry',
      scope: { kind: 'task', id: taskId },
    });
    let startedLive = false;
    try {
      startedLive = await blockedBefore(db, held, grant.expiry);
      await waitPast(db, grant.expiry);
    } finally {
      await held.letGo();
    }
    const answer = await starting;
    await db.admin.execute('update public.grants set expires_at = null where id = $1', [grant.id]);
    expect({
      startedLive,
      status: answer.status,
      code: answer.body['code'],
      kept: await w.count(CITING, [taskId]),
    }).toEqual({ startedLive: true, status: 403, code: 'SCOPE_NOT_GRANTED', kept: 0 });
  }, 30_000);

  /**
   * The colleague's keep `send`, sent while another writer ends their one
   * `conversation:write` grant and holds the audit chain: whether the keep
   * waited on that writer, what it answered once the writer committed.
   */
  async function behindAnEndingWriter(send: () => Promise<Answer>) {
    const { db, business } = w.fixture;
    const [grant] = await db.admin.execute<{ readonly id: string }>(
      `select id from public.grants where subject_id = $1 and collection = $2 and action = 'write'
          and revoked_at is null`,
      [w.colleague.personId, CONVERSATION],
    );
    const id = String(grant?.id);
    const held = await hold(db, async (execute) => {
      await execute('update public.grants set expires_at = clock_timestamp() where id = $1', [id]);
      // The chain trigger's own key: an audit event this writer wrote would hold it so.
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        business.toLowerCase(),
      ]);
    });
    const sending = send();
    let waited = false;
    try {
      waited = (await waiterOf(db, held)) !== '';
    } finally {
      await held.letGo();
    }
    const answer = await sending;
    await db.admin.execute('update public.grants set expires_at = null where id = $1', [id]);
    return { waited, status: answer.status, code: answer.body['code'] };
  }

  it('SEC1-1: a message whose conversation:write grant ends behind the audit chain it waits on is refused and keeps nothing', async () => {
    const taskId = await task(`Messaged behind the chain ${randomUUID()}`);
    const opened = await w.as(w.colleague, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
    });
    const conversationId = String(detail(opened)['conversationId']);
    const seen = await behindAnEndingWriter(
      async () => await w.as(w.colleague, 'conversation.message', { conversationId, body: 'now?' }),
    );
    expect({ ...seen, kept: await w.count(PERSON_MESSAGES, [conversationId]) }).toEqual({
      waited: true,
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
      kept: 1,
    });
  }, 30_000);

  it('SEC1-1: a start whose conversation:write grant ends behind the audit chain it waits on is refused and keeps nothing', async () => {
    const taskId = await task(`Started behind the chain ${randomUUID()}`);
    const seen = await behindAnEndingWriter(
      async () =>
        await w.as(w.colleague, 'conversation.start', {
          body: 'Sent behind the chain',
          scope: { kind: 'task', id: taskId },
        }),
    );
    expect({ ...seen, kept: await w.count(CITING, [taskId]) }).toEqual({
      waited: true,
      status: 403,
      code: 'SCOPE_NOT_GRANTED',
      kept: 0,
    });
  }, 30_000);
});
