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
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  CONTENT,
  kindsUnreached,
  lockFaults,
  markerFaults,
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

/** Mia's comment grant on one client. */
async function miaMayComment(client: string): Promise<void> {
  const mia = harness.world.mia as unknown as Member;
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await grantTo(tx, mia, 'comment', { kind: 'party', id: client });
  });
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

async function untilWaiting(
  execute: Parameters<Parameters<Harness['world']['db']['admin']['transaction']>[0]>[0],
): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [waiting] = await execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
    );
    if ((waiting?.n ?? 0) > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/**
 * The client change lands first: Mia's comment has read its authority for the
 * task's client and waits on the task's row lock, held here while the client
 * is changed to `to` and committed. Her answer once the lock is let go.
 */
async function changeLandsFirst(taskId: string, to: string): Promise<{ code: string }> {
  const { pending } = await harness.world.db.admin.transaction(async (execute) => {
    await execute('select id from records where id = $1 for update', [taskId]);
    const waiting = miaComments(taskId);
    await untilWaiting(execute);
    await execute('update records set uuid_7 = $2 where id = $1', [taskId, to]);
    return { pending: waiting };
  });
  return await pending;
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
    const found: string[] = [];
    for (const declaration of CONTENT) {
      // eslint-disable-next-line no-await-in-loop
      found.push(...(await markerFaults(declaration)));
    }
    expect(found).toStrictEqual([]);
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

  it('S0-5 client change refused once the task has content: a content write and a client change interleaved, in both orders', async () => {
    const [clientA, clientB] = [await newClient(), await newClient()];
    await miaMayComment(clientA);
    // Content first: the comment lands, and the change is refused.
    const first = await taskOn(clientA, 's0-5 content first');
    expect((await miaComments(first)).code).toBe('ok');
    const refused = await harness.asPerson('task.set_party', await setPartyBody(first, clientB));
    expect([refused.status, refused.code]).toStrictEqual([409, 'CLIENT_LOCKED']);
    // The change first: the comment is judged for client B, after the lock.
    const onlyA = await taskOn(clientA, 's0-5 change first, writer holds A');
    expect((await changeLandsFirst(onlyA, clientB)).code).toBe('SCOPE_NOT_GRANTED');
    await miaMayComment(clientB);
    const onBoth = await taskOn(clientA, 's0-5 change first, writer holds A and B');
    expect((await changeLandsFirst(onBoth, clientB)).code).toBe('ok');
  }, 180_000);
});
