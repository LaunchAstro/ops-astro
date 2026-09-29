// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 and R4 (REV186A criterion 13): an external party, standing on a read
// share with no membership, opens their own inbox item on the shared task and
// nobody else's; every other self-scoped write stays refused at R4.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { raiseInboxItem } from '../../packages/core-records/src/inbox/items.ts';
import { seedRecords, TITLE } from './external-party-records.ts';
import {
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Caller,
  type World,
} from './world.ts';

describe.skipIf(serverUrl === undefined)('R4: the external party and their own inbox item', () => {
  let world: World;
  let ext: Caller;
  let shared: string;

  const as = async (who: Caller, name: CommandName, body: Record<string, unknown>) =>
    await call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

  const revisionOf = async (recordId: string): Promise<number> => {
    const read = await as(world.ada, 'task.read', { recordId });
    return Number((read.body['task'] as Record<string, unknown>)['revision']);
  };

  beforeAll(async () => {
    world = await createWorld('r4_inbox');
    ext = await enrolExternal(world);
    ({ shared } = await seedRecords(world, as, revisionOf));
    const issued = await world.db.app.withBusiness(world.alpha, (tx) =>
      shareRecord(
        tx,
        { personId: world.ada.personId as string, actorId: world.ada.actorId as string },
        { collection: 'task', recordId: shared, personId: ext.personId as string },
      ),
    );
    expect(issued.ok).toBe(true);
  });

  afterAll(async () => {
    await world?.close();
  });

  it("INB-1 an external party opens their own item on the shared task, and nobody else's", async () => {
    const raise = async (recipientPersonId: string) =>
      await world.db.app.withBusiness(world.alpha, (tx) =>
        raiseInboxItem(tx, {
          recipientPersonId,
          subjectRecordId: shared,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
      );
    const own = await raise(ext.personId as string);
    const adas = await raise(world.ada.personId as string);
    const seen = async (itemId: string) =>
      await world.db.app.withBusiness(world.alpha, async (tx) =>
        (
          await tx.query<{ readonly person_id: string }>(
            'select person_id from public.inbox_attention where business_id = $1 and item_id = $2',
            [tx.businessId, itemId],
          )
        ).map((row) => row.person_id),
      );

    const opened = await as(ext, 'inbox.seen', { operationId: randomUUID(), itemId: own });
    expect(opened.status).toBe(200);
    expect(await seen(own)).toStrictEqual([ext.personId]);

    const other = await as(ext, 'inbox.seen', { operationId: randomUUID(), itemId: adas });
    expect(other.code).toBe('NOT_FOUND');
    expect(JSON.stringify(other.body)).not.toContain(TITLE);
    expect(await seen(adas)).toStrictEqual([]);
    // Every other self-scoped write stays refused at R4.
    const setting = await as(ext, 'notifications.set_channel', {
      operationId: randomUUID(),
      channel: 'email',
      mode: 'off',
    });
    expect(setting.code).toBe('SCOPE_NOT_GRANTED');
  });
});
