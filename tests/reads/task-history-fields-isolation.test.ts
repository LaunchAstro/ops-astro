// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one world, its isolation case */
//
// U116 isolation: two businesses, two clients, one grant each. A reader is
// sent the history of the tasks it may read, and a direct lookup finds only an
// entry of that history: another client's change, another business's change
// and the person who made them never reach it. A client's own person reads
// the shared view, which carries no history, and its lookup is not found.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alpha,
  admin,
  as,
  bravo,
  bravoAdmin,
  clientA,
  clientB,
  clientAPeople,
  db,
  fresh,
  revisionOf,
  serverUrl,
  setUp,
  SHARE,
  tearDown,
  toggle,
} from '../commands/client-access-world.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { HistoryEntry } from '../../packages/core-wire/src/index.ts';

const DUE = '2026-12-01T00:00:00.000Z';

const read = async (business: BusinessId, member: Member, recordId: string, eventId?: string) =>
  await executeRead(db.app, business, member.presented, {
    read: 'task.read',
    recordId,
    ...(eventId === undefined ? {} : { historyEventId: eventId }),
  } as never);

/** The task's history as `member` is sent it. */
async function historyOf(business: BusinessId, member: Member, recordId: string) {
  const answer = await read(business, member, recordId);
  if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
  return answer.task.history;
}

/** A due date set on the task by `who`, and its history entry as the business's admin reads it. */
async function due(business: BusinessId, who: Member, reader: Member, recordId: string) {
  const answer = await as(business, who, {
    command: 'task.update',
    recordId,
    expectedRevision: await revisionOf(recordId),
    fields: { due: DUE },
  });
  if (isCommandRefusal(answer)) throw new Error(`update refused ${answer.code}`);
  const entry = (await historyOf(business, reader, recordId)).at(-1);
  if (entry === undefined) throw new Error('no history entry');
  return entry;
}

describe.skipIf(serverUrl === undefined)('U116 history isolation', () => {
  beforeAll(setUp, 120_000);
  afterAll(tearDown);

  it('two businesses, two clients, one grant each', async () => {
    const mine = await fresh(alpha, admin, 'client A task', clientA);
    const other = await fresh(alpha, admin, 'client B task', clientB);
    const theirs = await fresh(bravo, bravoAdmin, 'bravo task', null);
    const otherWriter = await enrol(db.app, alpha, 'Client B Writer');
    const readerA = await enrol(db.app, alpha, 'client-a-reader');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, otherWriter, 'read', { kind: 'record', id: other });
      await grantTo(tx, otherWriter, 'write', { kind: 'record', id: other });
      await grantTo(tx, readerA, 'read', { kind: 'record', id: mine });
    });
    const own: HistoryEntry = await due(alpha, admin, admin, mine);
    const foreign = await due(alpha, otherWriter, admin, other);
    const bravoEntry = await due(bravo, bravoAdmin, bravoAdmin, theirs);
    expect(foreign.changed).toStrictEqual(['due']);

    // Client A's reader: its task's change, named; nothing of client B's or bravo's.
    const seen = await historyOf(alpha, readerA, mine);
    expect(seen.at(-1)).toStrictEqual(own);
    for (const id of [foreign.eventId, bravoEntry.eventId]) {
      // oxlint-disable-next-line no-await-in-loop
      const lookup = await read(alpha, readerA, mine, id);
      expect(lookup).toHaveProperty('task.historyEvent', null);
      expect(JSON.stringify(lookup)).not.toContain('Client B Writer');
    }
    const across = await read(alpha, readerA, other, foreign.eventId);
    expect(isCommandRefusal(across) ? across.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(across)).not.toContain(foreign.eventId);
    expect(JSON.stringify(across)).not.toContain('Client B Writer');

    // Another business: not found, the event's id and its writer never sent.
    const outside = await read(bravo, bravoAdmin, mine, own.eventId);
    expect(isCommandRefusal(outside) ? outside.code : 'answered').toBe('NOT_FOUND');
    expect(JSON.stringify(outside)).not.toContain(own.eventId);

    // Client A's own person reads the shared view: no history, and no lookup.
    await toggle(alpha, admin, SHARE, mine);
    const person = clientAPeople[0];
    if (person === undefined) throw new Error('client A has no people');
    const shared = await read(alpha, person, mine);
    expect(isCommandRefusal(shared)).toBe(false);
    expect(JSON.stringify(shared)).not.toContain('history');
    const lookup = await read(alpha, person, mine, own.eventId);
    expect(isCommandRefusal(lookup) ? lookup.code : 'answered').toBe('NOT_FOUND');
    expect(JSON.stringify(lookup)).not.toContain(own.eventId);
  });
});
