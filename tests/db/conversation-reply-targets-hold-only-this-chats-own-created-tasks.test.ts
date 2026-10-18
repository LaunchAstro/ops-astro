// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666's snapshot tables (20261019064100_conversation_reply_targets.sql) against Postgres: a
// snapshot belongs to an agent reply in a chat opened on no task, a target is a task that chat's
// own applied `task.create` made, the application only adds rows, and the purge's delete of the
// messages takes them. Chats, tasks and audit events are the real API's; the reply, snapshot and
// targets are written as the application role in one transaction, as the keep will. The one
// forged row (an audit event naming another business's task) is rolled back with the refusal it
// leads to. The stored rows, read as admin, are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { conversationWorld, started, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createTask } from '../tasks/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Target {
  readonly position: number;
  readonly taskId: string;
  readonly revision: number;
}
type Rows = readonly Target[];
type Refusal = Readonly<{ code: string; constraint: string | null; message: string }>;

/** What the server said to a write: its SQLSTATE, the constraint it names and its text. */
async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const failure = error as { code?: string; constraint_name?: string; message?: string };
    return {
      code: failure.code ?? 'unknown',
      constraint: failure.constraint_name ?? null,
      message: failure.message ?? String(error),
    };
  }
  return { code: 'accepted', constraint: null, message: '' };
}

/** The guard's refusal: a check violation naming its reason and the table it guarded. */
function expectGuard(refused: Refusal, reason: string, table: string): void {
  expect(refused.code).toBe('23514');
  expect(refused.message.startsWith(`${reason}: ${table}: `), refused.message).toBe(true);
}

/** An agent reply in `conversationId`, written as the keep writes one. */
async function insertReply(tx: TenantQuery, conversationId: string, author: Member) {
  const id = randomUUID();
  await tx.query(
    `insert into public.conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body)
     values ($1, $2, $3, 'agent', $4, 'Here is what I can change.')`,
    [tx.businessId, id, conversationId, author.actorId],
  );
  return id;
}

async function insertTarget(tx: TenantQuery, messageId: string, target: Target) {
  await tx.query(
    `insert into public.conversation_reply_targets
       (business_id, message_id, position, task_id, revision) values ($1, $2, $3, $4, $5)`,
    [tx.businessId, messageId, target.position, target.taskId, target.revision],
  );
}

/** A reply's snapshot and then its targets, in order. */
async function insertSnapshot(tx: TenantQuery, messageId: string, created: number, targets: Rows) {
  await tx.query(
    `insert into public.conversation_reply_snapshots (business_id, message_id, created)
     values ($1, $2, $3)`,
    [tx.businessId, messageId, created],
  );
  for (const target of targets) {
    // oxlint-disable-next-line no-await-in-loop -- one transaction, in position order
    await insertTarget(tx, messageId, target);
  }
}

// eslint-disable-next-line max-lines-per-function -- one world, the snapshot's rules on it
describe.skipIf(serverUrl === undefined)('reply snapshots hold their own chat’s tasks', () => {
  let w: ConversationWorld;
  let business: string;
  /** The owner's chat opened on no task, and the two tasks it created. */
  let chat: string;
  let first: Target;
  let second: Target;
  /** A conversation started before any snapshot, and an agent reply kept without one. */
  let legacy: string;
  let legacyReply: string;

  const app = async <T>(run: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await w.fixture.db.app.withBusiness(business, run);

  const createdIn = async (member: Member, title: string, conversationId?: string) => {
    const made = await w.as(member, 'task.create', { fields: { title }, conversationId });
    expect(made.status).toBe(200);
    return String(made.body['recordId']);
  };

  const at = async (taskId: string, position: number): Promise<Target> => ({
    position,
    taskId,
    revision: await w.count('select revision as n from public.records where id = $1', [taskId]),
  });

  /** The keep's writes in one transaction: the reply, its snapshot and its targets. */
  const keep = async (conversationId: string, created: number, targets: Rows) =>
    await app(async (tx) => {
      const messageId = await insertReply(tx, conversationId, w.owner);
      await insertSnapshot(tx, messageId, created, targets);
      return messageId;
    });

  const snapshotsIn = async (conversationId: string) =>
    await w.count(
      `select count(*) as n from public.conversation_reply_snapshots s
         join public.conversation_messages m on m.business_id = s.business_id and m.id = s.message_id
        where m.conversation_id = $1`,
      [conversationId],
    );

  const rowsFor = async (table: string, messageId: string) =>
    await w.count(`select count(*) as n from public.${table} where message_id = $1`, [messageId]);

  beforeAll(async () => {
    w = await conversationWorld('reply_targets');
    business = w.fixture.business;
    // The colleague creates tasks from a conversation of their own.
    await app(async (tx) => await grantTo(tx, w.colleague, 'write'));
    legacy = await started(w, w.owner, { body: 'Before snapshots existed' });
    legacyReply = await app(async (tx) => await insertReply(tx, legacy, w.owner));
    chat = await started(w, w.owner, { body: 'We need the printer booked' });
    first = await at(await createdIn(w.owner, 'Book the printer', chat), 1);
    second = await at(await createdIn(w.owner, 'Collect the proofs', chat), 2);
  }, 180_000);

  afterAll(async () => {
    await w?.drop();
  });

  it('an agent reply in an unscoped chat keeps a snapshot of the two tasks its audit chain shows it created', async () => {
    const messageId = await keep(chat, 2, [first, second]);
    const [snapshot] = await w.fixture.db.admin.execute<{ readonly created: number }>(
      'select created from public.conversation_reply_snapshots where message_id = $1',
      [messageId],
    );
    expect(snapshot?.created).toBe(2);
    const targets = await w.fixture.db.admin.execute(
      `select position, task_id::text as task, revision::text as revision
         from public.conversation_reply_targets where message_id = $1 order by position`,
      [messageId],
    );
    // The driver's rows are not plain objects, so the comparison is by value.
    expect([...targets]).toEqual([
      { position: 1, task: first.taskId, revision: String(first.revision) },
      { position: 2, task: second.taskId, revision: String(second.revision) },
    ]);
  });

  it.each([
    ['conversation_reply_targets_position_positive', 2, () => [{ ...first, position: 0 }]],
    ['conversation_reply_targets_revision_not_negative', 2, () => [{ ...first, revision: -1 }]],
    ['conversation_reply_targets_pkey', 2, () => [first, { ...second, position: 1 }]],
    ['conversation_reply_targets_task_once', 2, () => [first, { ...first, position: 2 }]],
    ['conversation_reply_snapshots_created_positive', 0, () => []],
  ] as const)('a malformed row is refused by %s and keeps nothing', async (name, created, rows) => {
    const before = await snapshotsIn(chat);
    const refused = await refusal(keep(chat, created, rows()));
    expect(refused.constraint).toBe(name);
    expect(refused.code).toMatch(/^23/u);
    expect(await snapshotsIn(chat)).toBe(before);
  });

  it('a task of another business is refused by the composite task key, even with an audit event naming it', async () => {
    const bravo = await insertBusiness(w.fixture.db.app, 'bravo');
    const spine = await installSpine(w.fixture.db.app, bravo);
    const foreign = await w.fixture.db.app.withBusiness(
      bravo,
      async (tx) => await createTask(tx, spine, { title: 'Bravo’s own task', parentId: null }),
    );
    const before = await snapshotsIn(chat);
    const refused = await refusal(
      app(async (tx) => {
        const messageId = await insertReply(tx, chat, w.owner);
        // Forged, so the guard passes and the key is what answers.
        await tx.query(
          `insert into public.audit_events (business_id, id, actor_id, command, outcome,
             payload_digest, subject_record_id, origin_conversation_id)
           values ($1, $2, $3, 'task.create', 'applied', $4, $5, $6)`,
          [tx.businessId, randomUUID(), w.owner.actorId, 'a'.repeat(64), foreign, chat],
        );
        await insertSnapshot(tx, messageId, 1, [{ position: 1, taskId: foreign, revision: 0 }]);
      }),
    );
    expect(refused.code).toBe('23503');
    expect(refused.constraint).toBe('conversation_reply_targets_task_fkey');
    expect(await snapshotsIn(chat)).toBe(before);
  });

  it('a task the chat did not create, made by a plain task.create, is refused by the guard', async () => {
    const plain = await at(await createdIn(w.owner, 'Made outside the chat'), 1);
    const refused = await refusal(keep(chat, 1, [plain]));
    expectGuard(refused, 'TARGET_NOT_CREATED_HERE', 'conversation_reply_targets');
  });

  it('a task created by another person’s chat is refused by the guard', async () => {
    const theirs = await started(w, w.colleague, { body: 'My own errands' });
    const made = await at(await createdIn(w.colleague, 'The colleague’s errand', theirs), 1);
    const refused = await refusal(keep(chat, 1, [made]));
    expectGuard(refused, 'TARGET_NOT_CREATED_HERE', 'conversation_reply_targets');
  });

  it('a person’s message takes neither a snapshot nor a target', async () => {
    const [asked] = await w.fixture.db.admin.execute<{ readonly id: string }>(
      `select id::text as id from public.conversation_messages
        where conversation_id = $1 and role = 'person' order by created_at limit 1`,
      [chat],
    );
    const question = String(asked?.id);
    const snapshot = await refusal(app(async (tx) => await insertSnapshot(tx, question, 1, [])));
    expectGuard(snapshot, 'REPLY_NOT_AGENT', 'conversation_reply_snapshots');
    // The target's own guard answers before its key to a snapshot is checked.
    const target = await refusal(app(async (tx) => await insertTarget(tx, question, first)));
    expectGuard(target, 'REPLY_NOT_AGENT', 'conversation_reply_targets');
  });

  it('a reply in a chat opened on a task takes neither a snapshot nor a target', async () => {
    const open = await createdIn(w.owner, 'The open task');
    const scoped = await started(w, w.owner, { body: 'Edit', scope: { kind: 'task', id: open } });
    const made = await at(await createdIn(w.owner, 'Made in the task chat', scoped), 1);
    const snapshot = await refusal(keep(scoped, 1, [made]));
    expectGuard(snapshot, 'REPLY_CONVERSATION_SCOPED', 'conversation_reply_snapshots');
    const target = await refusal(
      app(async (tx) => await insertTarget(tx, await insertReply(tx, scoped, w.owner), made)),
    );
    expectGuard(target, 'REPLY_CONVERSATION_SCOPED', 'conversation_reply_targets');
    expect(await snapshotsIn(scoped)).toBe(0);
  });

  it('the application role can neither update nor delete a snapshot or a target', async () => {
    const messageId = await keep(chat, 2, [first, second]);
    for (const statement of [
      'update public.conversation_reply_snapshots set created = created + 1 where message_id = $1',
      'update public.conversation_reply_targets set revision = revision + 1 where message_id = $1',
      'delete from public.conversation_reply_targets where message_id = $1',
      'delete from public.conversation_reply_snapshots where message_id = $1',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each statement in its own transaction
      const refused = await refusal(app(async (tx) => await tx.query(statement, [messageId])));
      expect(refused.code, statement).toBe('42501');
    }
    expect(await rowsFor('conversation_reply_snapshots', messageId)).toBe(1);
    expect(await rowsFor('conversation_reply_targets', messageId)).toBe(2);
  });

  it('the purge’s delete of a conversation’s messages takes its snapshots and targets with it', async () => {
    const purged = await started(w, w.owner, { body: 'Short-lived chat' });
    const made = await at(await createdIn(w.owner, 'Outlives its chat', purged), 1);
    const messageId = await keep(purged, 1, [made]);
    await w.age(purged, 8);
    const wrapped = await app(
      async (tx) => await writeWrapUp(tx, { conversationId: purged, codeRevision: 'replytargets' }),
    );
    expect(wrapped).toMatchObject({ ok: true, written: true });
    // purgeConversation's own statement, as the application role.
    const purge = `delete from conversation_messages
      where business_id = $1 and conversation_id = $2 returning id`;
    const gone = await app(async (tx) => await tx.query(purge, [tx.businessId, purged]));
    expect(gone.length).toBeGreaterThanOrEqual(2);
    expect(await rowsFor('conversation_reply_snapshots', messageId)).toBe(0);
    expect(await rowsFor('conversation_reply_targets', messageId)).toBe(0);
    // The task is not the body: it stays.
    const tasks = 'select count(*) as n from public.records where id = $1';
    expect(await w.count(tasks, [made.taskId])).toBe(1);
  });

  it('messages kept before any snapshot still read, with no snapshot rows', async () => {
    const rows = await app(
      async (tx) =>
        await tx.query<{ id: string; role: string; created: number | null }>(
          `select m.id::text as id, m.role, s.created
             from public.conversation_messages m
             left join public.conversation_reply_snapshots s
               on s.business_id = m.business_id and s.message_id = m.id
            where m.conversation_id = $1`,
          [legacy],
        ),
    );
    expect(rows.map((row) => row.role)).toContain('person');
    expect(rows.find((row) => row.id === legacyReply)?.role).toBe('agent');
    expect(rows.every((row) => row.created === null)).toBe(true);
  });
});
