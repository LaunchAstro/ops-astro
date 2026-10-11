// SPDX-License-Identifier: AGPL-3.0-only
//
// P20 (U115) isolation: two businesses, two clients, one grant each. Field
// names are recorded only for a write the caller is allowed, only in the
// writer's own business, and a refused write records none and names nothing
// of the task it was refused on.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alpha,
  admin,
  as,
  bravo,
  bravoAdmin,
  clientA,
  clientB,
  db,
  fresh,
  revisionOf,
  serverUrl,
  setUp,
  tearDown,
} from './client-access-world.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { eventsOf, taskRow } from './field-changes-world.ts';

const CANARY = `P20 other client canary ${randomUUID()}`;

/** A one-field rename of the task as it stands, and the operation id it went under. */
async function rename(business: BusinessId, who: Member, recordId: string, title: string) {
  const operationId = randomUUID();
  const answer = await as(business, who, {
    command: 'task.update',
    operationId,
    recordId,
    expectedRevision: await revisionOf(recordId),
    fields: { title },
  });
  return { operationId, answer };
}

// eslint-disable-next-line max-lines-per-function -- one world, its one isolation case
describe.skipIf(serverUrl === undefined)('P20 field names stay inside the writer’s reach', () => {
  beforeAll(setUp, 90_000);
  afterAll(tearDown);

  // eslint-disable-next-line max-lines-per-function -- each write and its stored events, in order
  it('two businesses, two clients, one grant each', async () => {
    const mine = await fresh(alpha, admin, 'client A task', clientA);
    const other = await fresh(alpha, admin, CANARY, clientB);
    const theirs = await fresh(bravo, bravoAdmin, 'bravo task', null);
    const writer = await enrol(db.app, alpha, 'p20-client-a-writer');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, writer, 'write', { kind: 'record', id: mine });
    });
    const own = await rename(alpha, writer, mine, 'client A task renamed');
    expect(own.answer).toHaveProperty('detail.changed', ['title']);

    const otherBefore = await taskRow(db.admin, other);
    const refused = await rename(alpha, writer, other, 'probe');
    expect(refused.answer).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(refused.answer)).not.toContain(CANARY);
    expect(await taskRow(db.admin, other)).toStrictEqual(otherBefore);

    const crossBefore = await taskRow(db.admin, mine);
    const cross = await rename(bravo, bravoAdmin, mine, 'cross-business probe');
    expect(cross.answer).toMatchObject({ refused: true, code: 'NOT_FOUND' });
    expect(await taskRow(db.admin, mine)).toStrictEqual(crossBefore);

    const home = await rename(bravo, bravoAdmin, theirs, 'bravo task renamed');
    expect(home.answer).toHaveProperty('detail.changed', ['title']);

    const events = await eventsOf(db.admin, [
      own.operationId,
      refused.operationId,
      cross.operationId,
      home.operationId,
    ]);
    const shown = events.map((e) => [
      e.business_id,
      e.row['operation_id'],
      e.outcome,
      e.field_changes,
    ]);
    expect(shown).toHaveLength(4);
    expect(shown).toEqual(
      expect.arrayContaining([
        [alpha, own.operationId, 'applied', { version: 1, keys: ['title'] }],
        [alpha, refused.operationId, 'refused', null],
        [bravo, cross.operationId, 'refused', null],
        [bravo, home.operationId, 'applied', { version: 1, keys: ['title'] }],
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(CANARY);
    for (const business of [alpha, bravo]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await db.app.withBusiness(business, verifyAuditChain)).toMatchObject({ intact: true });
    }
  });
});
