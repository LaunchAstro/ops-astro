// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: a task's client is locked once the task has content (owner line 75).
//
// Content is anything in the task's history beyond its creation and earlier
// client changes. Every task-content command (one that writes a client-scoped
// record kind, read from the catalogue's effect metadata) leaves its marker:
// an applied history event on the task and a new revision, in its own
// transaction. `task.set_party` reads that history under the task's row lock
// and refuses `CLIENT_LOCKED` 409, writing nothing. A content write takes the
// task's row lock and derives the task's client again under it, so a client
// change that lands first is judged by the writer's authority for the new
// client. Run through the real API and the CLI client on a throwaway database.
// The app and agent-credential legs are held in `s0-5-client-lock-held.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  CONTENT,
  kindsUnreached,
  lockFaults,
  allMarkerFaults,
  newClient,
  revisionOf,
  setPartyBody,
  touched,
  useHarness,
} from './s0-5-client-lock-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-client-lock: DATABASE_URL is unset, so nothing below ran.');
}

let harness: Harness;

/** A fresh task on `client`, changed there while empty. */
async function taskOn(client: string, title: string): Promise<string> {
  const task = await harness.freshTask(title);
  const set = await harness.asPerson('task.set_party', await setPartyBody(task.id, client));
  expect(set.code).toBe('ok');
  return task.id;
}

/** Mia comments on the task, as a person. */
async function miaComments(taskId: string): Promise<{ code: string }> {
  return await harness.asPerson(
    'task.comment',
    {
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      body: 'a note',
      audience: 'internal',
    },
    undefined,
    { token: harness.world.mia.token },
  );
}

async function clientOf(taskId: string): Promise<string> {
  const [row] = await harness.world.db.admin.execute<{ client: string }>(
    'select uuid_7::text as client from records where id = $1',
    [taskId],
  );
  return row!.client;
}

/**
 * The client change lands first. A separate database connection takes the
 * task's row lock, waits until the comment is queued behind it, changes the
 * client to `to` and commits. Whether the session saw it waiting, and her answer.
 */
async function changeLandsFirst(taskId: string, to: string): Promise<[boolean, string]> {
  if (serverUrl === undefined) throw new Error('This fixture requires Postgres.');
  const url = new URL(serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  const locker = connectAsAdmin(url.toString());
  let comment: ReturnType<typeof miaComments> | undefined;
  try {
    const waited = await locker.transaction(async (execute) => {
      await execute('select id from records where id = $1 for update', [taskId]);
      comment = miaComments(taskId);
      let waiting = false;
      const deadline = Date.now() + 10_000;
      while (!waiting && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- Wait for this connection's row lock.
        const [row] = await execute<{ waiting: boolean }>(
          `select exists (select 1 from pg_locks where not granted and locktype = 'transactionid'
             and pg_backend_pid() = any(pg_blocking_pids(pid))) as waiting`,
        );
        waiting = row?.waiting === true;
        if (!waiting) {
          // eslint-disable-next-line no-await-in-loop -- Poll until the comment is blocked.
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
        }
      }
      await execute(
        "update records set data = jsonb_set(data, '{client}', to_jsonb($2::text)) where id = $1",
        [taskId, to],
      );
      return waiting;
    });
    if (comment === undefined) throw new Error('The comment was not started.');
    return [waited, (await comment).code];
  } finally {
    await Promise.allSettled([comment]);
    await locker.close();
  }
}

/** An empty task's client changes, twice. */
async function emptyTaskMovesTwice(client: string): Promise<void> {
  const empty = await harness.freshTask('s0-5 an empty task');
  expect(
    (await harness.asPerson('task.set_party', await setPartyBody(empty.id, client))).code,
  ).toBe('ok');
  const again = await setPartyBody(empty.id, await newClient());
  expect((await harness.asPerson('task.set_party', again)).code).toBe('ok');
}

/** A task that has gained a subtask: its client change, refused or not. */
async function parentWithSubtaskMoves(): Promise<[number, string]> {
  const parent = await harness.freshTask('s0-5 a parent');
  const child = await harness.freshTask('s0-5 its subtask');
  const placed = await harness.asPerson('task.reparent', {
    recordId: child.id,
    expectedRevision: child.revision,
    parentId: parent.id,
  });
  expect(placed.code).toBe('ok');
  const client = await newClient();
  const moved = await harness.asPerson('task.set_party', await setPartyBody(parent.id, client));
  return [moved.status, moved.code];
}

/**
 * An empty subtask, made under a parent on one client, asked onto another: the
 * answer, and whether the subtask still carries its parent's client.
 */
async function emptySubtaskMoves(): Promise<[string, boolean]> {
  const [clientA, clientB] = [await newClient(), await newClient()];
  const parent = await taskOn(clientA, 's0-5 a parent on its client');
  const made = await harness.asPerson('task.create', {
    fields: { title: 's0-5 an empty subtask' },
    parentId: parent,
  });
  expect(made.code).toBe('ok');
  const child = String(made.body['recordId']);
  const moved = await harness.asPerson('task.set_party', await setPartyBody(child, clientB));
  return [moved.code, (await clientOf(child)) === clientA];
}

/** Content then a client change, and a client change then content, on two tasks. */
async function contentAndChangeInterleaved(): Promise<void> {
  const [clientA, clientB] = [await newClient(), await newClient()];
  // Content first (Mia comments, then Ada changes the client): refused.
  const first = await taskOn(clientA, 's0-5 content first');
  expect((await miaComments(first)).code).toBe('ok');
  const refused = await harness.asPerson('task.set_party', await setPartyBody(first, clientB));
  expect([refused.status, refused.code]).toStrictEqual([409, 'CLIENT_LOCKED']);
  // The change first: the comment waits on the row lock, is refused stale
  // against the change's revision and writes nothing; its retry lands on the
  // task as it now stands, and from then on the client is locked.
  const second = await taskOn(clientA, 's0-5 change first');
  expect(await changeLandsFirst(second, clientB)).toStrictEqual([true, 'VERSION_STALE']);
  expect(await clientOf(second)).toBe(clientB);
  expect((await miaComments(second)).code).toBe('ok');
  const after = await harness.asPerson('task.set_party', await setPartyBody(second, clientA));
  expect([after.status, after.code]).toStrictEqual([409, 'CLIENT_LOCKED']);
}

describe.skipIf(serverUrl === undefined)('S0-5 the task client lock', () => {
  beforeAll(async () => {
    harness = await createHarness('s05_lock');
    useHarness(harness);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('S0-5 content marker and lock order: every task-content command leaves a history event and a new revision on its task, or a row naming it where the marker is held', async () => {
    expect(CONTENT.length).toBeGreaterThan(0);
    expect(await allMarkerFaults()).toStrictEqual([]);
  }, 300_000);

  it('S0-5 client change refused once the task has content', async () => {
    const client = await newClient();
    await emptyTaskMovesTwice(client);
    const found: string[] = [];
    for (const [name, taskId] of touched) {
      // eslint-disable-next-line no-await-in-loop
      found.push(...(await lockFaults(name, taskId, client)));
    }
    expect(found).toStrictEqual([]);
    expect(kindsUnreached()).toStrictEqual([]);
  }, 300_000);

  it('S0-5 client change refused once the task has content: a subtask is content of its parent', async () => {
    expect(await parentWithSubtaskMoves()).toStrictEqual([409, 'CLIENT_LOCKED']);
  });

  it('S0-5 client change on an empty subtask: the lock passes it to MP-4-4, which holds it to its parent client', async () => {
    expect(await emptySubtaskMoves()).toStrictEqual(['PLACEMENT_IS_DERIVED', true]);
  });

  it('S0-5 client change refused once the task has content: a content write and a client change interleaved, in both orders', async () => {
    await contentAndChangeInterleaved();
  }, 180_000);
});
