// SPDX-License-Identifier: AGPL-3.0-only
//
// #2345: a person deletes a task, and an owner can bring it back.
//
// `task.delete` is the bin (`task.trash`) behind two more checks: it is
// `task:decide`, a person's act, and it refuses a task whose subtree carries
// money, run or client history, which is closed instead. Nothing is
// removed: the rows stay, marked deleted, and `task.restore` returns them by
// the batch the delete answered with.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import { envelopeOf, lockedOrDefault } from '../../packages/core-custody/src/broker-hold.ts';
import { insertStarted } from '../../packages/core-custody/src/broker-message-call.ts';
import { slotOf, TASK_SPINE } from '../../packages/core-records/src/index.ts';
import type { ModelOperation } from '../../packages/core-connectors/src/index.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { serverUrl, type Answer } from './world.ts';

/** The broker's route for the call, a local replay that sends nothing. */
const ROUTE = {
  key: 'test_local_replay',
  reach: 'local',
  provider: 'replay',
  credentialRef: 'test_replay',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 100,
} as const;

/** Its first character percent-encoded, as a browser may send it. */
const encodedFirst = (ref: string): string =>
  `%${(ref.codePointAt(0) ?? 0).toString(16).toUpperCase()}${ref.slice(1)}`;

/** Every spelling of a task's page the exchange reads as that task (`taskPageRef`). */
const spellings = {
  id: (id: string) => id,
  upperId: (id: string) => id.toUpperCase(),
  encodedId: (id: string) => encodedFirst(id),
  key: (_id: string, key: string) => key,
  encodedKey: (_id: string, key: string) => encodedFirst(key),
} as const;

// eslint-disable-next-line max-lines-per-function -- one fixture, and the cases that share it
describe.skipIf(serverUrl === undefined)('task.delete', () => {
  let harness: Harness;

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await harness.world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [harness.world.alpha, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  /** A fresh task with one of the fixture's clients set on it. */
  const clientTask = async (title: string): Promise<{ readonly id: string }> => {
    const task = await harness.freshTask(title);
    const clients = await harness.world.db.admin.execute<{ readonly id: string }>(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       values ($1, gen_random_uuid(), $3, $2) returning id::text as id`,
      [harness.world.alpha, harness.world.ada.actorId, `Delete client ${randomUUID()}`],
    );
    const set = await harness.asPerson('task.set_party', {
      recordId: task.id,
      expectedRevision: task.revision,
      fields: { client: clients[0]?.id },
    });
    expect(set.code, 'the client link').toBe('ok');
    return task;
  };

  const remove = async (recordId: string, caller?: { readonly token: string }): Promise<Answer> =>
    await harness.asPerson(
      'task.delete',
      { recordId, expectedRevision: await revisionOf(recordId) },
      'alpha',
      caller,
    );

  const listed = async (recordId: string): Promise<{ board: boolean; search: boolean }> => {
    const board = await harness.asPerson('task.board', { board: null });
    const search = await harness.asPerson('task.search', { query: 'deletable' });
    return {
      board: JSON.stringify(board.body).includes(recordId),
      search: JSON.stringify(search.body).includes(recordId),
    };
  };

  const auditOf = async (recordId: string) =>
    await harness.world.db.admin.execute<{ readonly command: string; readonly outcome: string }>(
      `select command, outcome from public.audit_events
        where business_id = $1 and subject_record_id = $2 and command = 'task.delete'`,
      [harness.world.alpha, recordId],
    );

  beforeAll(async () => {
    harness = await createHarness('task_delete_2345');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('deletes a plain task, hides it from reads and lists, audits it, and restores it', async () => {
    const task = await harness.freshTask('a deletable plain task');
    expect(await listed(task.id)).toStrictEqual({ board: true, search: true });

    const deleted = await remove(task.id);
    console.log(`delete a plain task: ${deleted.status} ${deleted.code}`);
    expect(deleted.code).toBe('ok');
    const batchId = (deleted.body['detail'] as Record<string, unknown>)['batchId'];
    expect(typeof batchId).toBe('string');

    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('NOT_FOUND');
    expect(await listed(task.id)).toStrictEqual({ board: false, search: false });
    expect(await auditOf(task.id)).toStrictEqual([{ command: 'task.delete', outcome: 'applied' }]);

    const rows = await harness.world.db.admin.execute<{ readonly by: string | null }>(
      `select deleted_by_actor_id::text as by from public.records where business_id = $1 and id = $2`,
      [harness.world.alpha, task.id],
    );
    expect(rows).toStrictEqual([{ by: harness.world.ada.actorId }]);

    const restored = await harness.asPerson('task.restore', { batchId });
    expect(restored.code).toBe('ok');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
    expect(await listed(task.id)).toStrictEqual({ board: true, search: true });
  });

  it('refuses a task with money and run history, and leaves it readable', async () => {
    const { subject } = await harness.approvedReservation();
    const refused = await remove(subject.id);
    console.log(`delete a task with a reservation: ${refused.status} ${refused.code}`);
    expect(refused.code).toBe('TASK_NOT_DELETABLE');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('Cancel its run instead');
    expect((await harness.asPerson('task.read', { recordId: subject.id })).code).toBe('ok');
  });

  // S2348-1: a conversation names its task by its scope, or else by the page
  // added to it (`/task/<id>`), and planning spend on either is the task's.
  it.each(['scope', 'page'] as const)(
    'refuses a task with planning spend on a conversation naming it by its %s',
    async (by) => {
      const task = await harness.freshTask(`a deletable task planned by its ${by}`);
      const started = await harness.asPerson('conversation.start', {
        body: 'Plan this task',
        ...(by === 'scope'
          ? { scope: { kind: 'task', id: task.id } }
          : { page: { address: `/task/${task.id}`, shows: 'the task' } }),
      });
      expect(started.code, 'the conversation').toBe('ok');
      const conversationId = String(
        (started.body['detail'] as Record<string, unknown>)['conversationId'],
      );
      await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
        const cap = await lockedOrDefault(tx);
        await envelopeOf(tx, cap.id, {
          conversation: {
            id: conversationId,
            businessId: harness.world.alpha,
            ownerPersonId: String(harness.world.ada.personId),
          },
          operation: 'model.conversation',
          fields: [],
        });
      });
      expect((await remove(task.id)).code).toBe('TASK_NOT_DELETABLE');
      expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
    },
  );

  /** A model call with no planning envelope, written as the broker writes one. */
  const modelCall = async (business: string, ownerPersonId: string, started: Answer) => {
    const detail = started.body['detail'] as Record<string, unknown>;
    const conversationId = String(detail['conversationId']);
    const request = {
      conversation: { id: conversationId, businessId: business, ownerPersonId },
      messageId: String(detail['messageId']),
      fields: [],
      operation: 'model.conversation',
    };
    // The insert reads the operation's key alone; the call carries nothing (no carrier).
    const operation = { key: 'model.conversation' } as ModelOperation;
    const call = await harness.world.db.app.withBusiness(
      business,
      async (tx) =>
        // oxlint-disable-next-line no-useless-undefined -- the carrier parameter is required
        await insertStarted(tx, request, operation, ROUTE, null, undefined),
    );
    expect(typeof call, 'the model call').toBe('string');
    const envelopes = await harness.world.db.admin.execute(
      `select 1 from public.planning_envelopes where business_id = $1 and conversation_id = $2`,
      [business, conversationId],
    );
    expect(envelopes, 'no planning envelope').toStrictEqual([]);
  };

  /** A conversation with `address` as its added page, and a model call on its first message. */
  const modelCallOnPage = async (address: string, businessKey: 'alpha' | 'bravo' = 'alpha') => {
    const { world } = harness;
    const [business, caller] =
      businessKey === 'alpha' ? [world.alpha, world.ada] : [world.bravo, world.bea];
    const started = await harness.asPerson(
      'conversation.start',
      { body: 'Plan this task', page: { address, shows: 'the task' } },
      businessKey,
      caller,
    );
    expect(started.code, 'the conversation').toBe('ok');
    await modelCall(business, String(caller.personId), started);
  };

  const keyOf = async (recordId: string): Promise<string> => {
    const rows = await harness.world.db.admin.execute<{ readonly key: string }>(
      `select ${slotOf(TASK_SPINE, 'key')} as key from public.records
        where business_id = $1 and id = $2`,
      [harness.world.alpha, recordId],
    );
    return String(rows[0]?.key);
  };

  // #2350: a model call with no planning envelope is spend too, on a conversation naming the
  // task by its page in any spelling the exchange reads.
  it.each(Object.keys(spellings) as (keyof typeof spellings)[])(
    'refuses a task with a model call on a conversation paging it by its %s',
    async (spelling) => {
      const task = await harness.freshTask(`a deletable task paged by its ${spelling}`);
      await modelCallOnPage(`/task/${spellings[spelling](task.id, await keyOf(task.id))}`);
      const refused = await remove(task.id);
      expect(refused.code).toBe('TASK_NOT_DELETABLE');
      expect(refused.status).toBe(409);
      expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
    },
  );

  it('deletes a task another business pages by its id', async () => {
    await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
      await grantTo(tx, harness.world.bea as Member, 'write', undefined, false, 'conversation');
    });
    const task = await harness.freshTask('a deletable task paged from another business');
    await modelCallOnPage(`/task/${task.id}`, 'bravo');
    expect((await remove(task.id)).code).toBe('ok');
  });

  it('refuses a task linked to a client', async () => {
    const task = await clientTask('a deletable client task');
    const refused = await remove(task.id);
    expect(refused.code).toBe('TASK_NOT_DELETABLE');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
  });

  it('refuses a parent whose subtask has run history, and deletes neither', async () => {
    const parent = await harness.freshTask('a deletable parent');
    const { subject: child } = await harness.approvedReservation();
    const moved = await harness.asPerson('task.reparent', {
      recordId: child.id,
      expectedRevision: await revisionOf(child.id),
      parentId: parent.id,
    });
    expect(moved.code, 'the reparent').toBe('ok');

    expect((await remove(parent.id)).code).toBe('TASK_NOT_DELETABLE');
    const reads = await Promise.all(
      [parent.id, child.id].map(
        async (id) => await harness.asPerson('task.read', { recordId: id }),
      ),
    );
    expect(reads.map((read) => read.code)).toStrictEqual(['ok', 'ok']);
  });

  it('refuses a member who can write tasks but not decide on them', async () => {
    const task = await harness.freshTask('a deletable task a member tries');
    const refused = await remove(task.id, harness.world.mia);
    expect(refused.code).toBe('SCOPE_NOT_GRANTED');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
  });

  it('refuses an agent credential', async () => {
    const task = await harness.freshTask('a deletable task an agent tries');
    const refused = await harness.asAgent('task.delete', {
      recordId: task.id,
      expectedRevision: task.revision,
    });
    console.log(`delete as an agent: ${refused.status} ${refused.code}`);
    expect(refused.status).toBe(403);
    expect(refused.code).not.toBe('ok');
    expect((await harness.asPerson('task.read', { recordId: task.id })).code).toBe('ok');
  });
});
