// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, defect 3: the idle sweep starves.
//
// core-commands conversation-sweep.ts picks its purge candidates as the
// oldest PASS_LIMIT (100) wrapped, unpurged conversations past the floor,
// held ones included, and a held conversation stays a candidate on every
// pass. So once 100 older conversations are held (open work), no pass ever
// reaches a younger one that is due. And taskWork in conversation-contents.ts
// reads a conversation's scoped task without looking at deleted_at, so a task
// that is trashed (not completed) reads as open work and holds the purge with
// WORK_OPEN for ever.
//
// Red on 3338f1fd6:
// - case B: the conversation on the trashed task is held WORK_OPEN on every
//   pass;
// - case A: the unscoped conversation, due and wrapped, is not purged after
//   two passes and keeps its message.
// Green once the purge candidates skip or page past held conversations (A) and
// a trashed task counts as ended work, at its trash time (B).
//
// Case B runs first: its conversation, if held, only adds to case A's held
// ones and does not change what case A proves.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepConversations, type SweepReport } from '../../packages/core-commands/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CODE_REVISION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** As many as one pass takes of each kind (PASS_LIMIT). */
const HELD = 100;

// eslint-disable-next-line max-lines-per-function -- one world, two cases
describe.skipIf(serverUrl === undefined)('REVIEW-3A-3 idle sweep starvation', () => {
  let w: ConversationWorld;

  const sweep = async (): Promise<SweepReport> =>
    await sweepConversations(w.fixture.db.app, {
      businessId: w.fixture.business,
      codeRevision: CODE_REVISION,
    });
  const messages = async (id: string): Promise<number> =>
    await w.count(
      `select count(*) as n from public.conversation_messages where conversation_id = $1`,
      [id],
    );
  const purgedAt = async (id: string): Promise<unknown> =>
    (
      await w.fixture.db.admin.execute<{ readonly at: unknown }>(
        `select body_purged_at as at from public.conversations where id = $1`,
        [id],
      )
    )[0]?.at;

  async function openTask(title: string): Promise<string> {
    const created = await w.as(w.owner, 'task.create', { fields: { title } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return (created.body as { recordId: string }).recordId;
  }

  beforeAll(async () => {
    w = await conversationWorld('rv3a3');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'manage');
      // Owned by its command since 0068 (MP-2-11), so the write names it.
      const written = await writeBusinessSetting(tx, {
        key: 'conversation_window_days',
        owningOperation: 'settings.set_conversation_window',
        value: 7,
      });
      if (written === undefined || 'refused' in written) throw new Error('window not written');
    });
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('REVIEW-3A-3: a conversation on a task that was trashed, not completed, is not held WORK_OPEN for ever (taskWork ignores deleted_at)', async () => {
    const taskId = await openTask('trashed, not completed');
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      body: 'About a task that will be trashed.',
    });
    const read = await w.as(w.owner, 'task.read', { recordId: taskId });
    const revision = (read.body['task'] as { revision: number }).revision;
    const trashed = await w.as(w.owner, 'task.trash', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: revision,
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
    // Trashed ten days ago and quiet ten days: past the seven-day window either way.
    await w.fixture.db.admin.execute(
      `update public.records set deleted_at = now() - interval '10 days' where id = $1`,
      [taskId],
    );
    await w.age(conversationId, 10);

    const first = await sweep();
    expect(first.wrapped).toContain(conversationId);
    const second = await sweep();
    const third = await sweep();
    for (const report of [second, third]) {
      expect(
        report.held,
        'the conversation on a trashed task is held WORK_OPEN on every pass',
      ).not.toContainEqual({ conversationId, code: 'WORK_OPEN' });
    }
    expect([...second.purged, ...third.purged]).toContain(conversationId);
    expect(await messages(conversationId)).toBe(0);
  });

  // eslint-disable-next-line max-lines-per-function -- the setup is the case
  it('REVIEW-3A-3: 100 older held conversations do not starve a younger due one (purge candidates are the oldest 100 wrapped, held ones included)', async () => {
    const taskId = await openTask('open work for a hundred conversations');
    const template = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      body: 'Held by open work.',
    });
    await w.age(template, 10);
    // The other 99 are the template's row again under new ids: the clock and
    // the scope are what the sweep reads, and inserting them is the fixture's
    // one shortcut. Each cites the open task, so each is held WORK_OPEN.
    await w.fixture.db.admin.execute(
      `insert into public.conversations
         (business_id, id, owner_actor_id, owner_person_id, title, subject, scope_kind,
          scope_record_id, created_at, last_activity_at)
       select business_id, gen_random_uuid(), owner_actor_id, owner_person_id, title, subject,
              scope_kind, scope_record_id, created_at, last_activity_at
         from public.conversations, generate_series(2, $2::int)
        where id = $1`,
      [template, HELD],
    );
    const unscoped = await started(w, w.owner, { body: 'No scope, due by eight days.' });
    await w.age(unscoped, 8);
    expect(
      await w.count(
        `select count(*) as n from public.conversations
          where scope_record_id = $1 and body_purged_at is null`,
        [taskId],
      ),
    ).toBe(HELD);

    // The wrap-ups, written by the sweep itself: the first pass wraps the
    // hundred oldest, the next wraps the unscoped one.
    await sweep();
    await sweep();
    expect(
      await w.count(
        `select count(*) as n from public.conversation_wrap_ups w
           join public.conversations c on c.business_id = w.business_id and c.id = w.conversation_id
          where w.activity_through = c.last_activity_at and (c.scope_record_id = $1 or c.id = $2)`,
        [taskId, unscoped],
      ),
    ).toBe(HELD + 1);
    expect(await messages(unscoped)).toBe(1);

    // Now every one is wrapped, the hundred are held and the unscoped one is due.
    const first = await sweep();
    const second = await sweep();
    expect(
      [...first.purged, ...second.purged],
      `after two passes the due conversation is purged (held this time: ${String(first.held.length)} then ${String(second.held.length)})`,
    ).toContain(unscoped);
    expect(await purgedAt(unscoped)).not.toBeNull();
    expect(await messages(unscoped)).toBe(0);
  }, 120_000);
});
