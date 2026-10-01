// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 Client field on real sources: task.read sends a client id only to a
// member whose grants reach that client; the shared view sends neither field.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { enrol, grantTo, shareWithClient, type Member } from '../commands/fixture.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { commandOk, madeClient } from '../commands/todo-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const live = describe.skipIf(serverUrl === undefined);

let w: TimeWorld;
let bea: Member;
let clientA: string;
let clientB: string;
let taskA: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('solcr');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'share');
  });
  clientA = await madeClient(w, w.alpha, w.ada);
  clientB = await madeClient(w, w.alpha, w.ada);
  taskA = await w.fresh(w.alpha, w.ada, 'Task under client A');
  await commandOk(w, w.alpha, w.ada, {
    command: 'task.set_party',
    recordId: taskA,
    fields: { client: clientA },
  });
  // A member held to client B, with one task of client A shared to them.
  bea = await enrol(w.db.app, w.alpha, 'bea');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, bea, 'read', { kind: 'party', id: clientB });
    await grantTo(tx, bea, 'read', { kind: 'record', id: taskA });
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

live('task.read names a client only to a reader it reaches', () => {
  it('a member whose grants do not reach client A is not sent A’s id by task.read', async () => {
    const listed = await executeRead(w.db.app, w.alpha, bea.presented, {
      read: 'client.list',
    } as never);
    if (isCommandRefusal(listed) || !('clients' in listed)) throw new Error('client.list refused');
    const ids = (listed.clients as readonly { clientId: string }[]).map((c) => c.clientId);
    // client.list keeps "no count or trace" of client A from this reader.
    expect(ids).toStrictEqual([clientB]);
    const read = await executeRead(w.db.app, w.alpha, bea.presented, {
      read: 'task.read',
      recordId: taskA,
    } as never);
    if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
    // task.read must not hand the same reader the id client.list withholds.
    expect(JSON.stringify(read)).not.toContain(clientA);
  });

  it('the shared view carries neither client nor hasContent', async () => {
    const outsider = await shareWithClient(w.db.app, w.alpha, w.ada, taskA);
    const read = await executeRead(w.db.app, w.alpha, outsider.presented, {
      read: 'task.read',
      recordId: taskA,
    } as never);
    if (isCommandRefusal(read)) throw new Error(`shared read refused ${read.code}`);
    const body = JSON.stringify(read);
    expect('sharedTask' in read).toBe(true);
    expect(body).not.toContain(clientA);
    expect(body).not.toContain('hasContent');
  });
});
