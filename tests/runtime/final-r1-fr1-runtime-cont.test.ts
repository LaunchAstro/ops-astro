// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, FR1-RUNTIME continuation (coordinator 31 rulings).
//
// #53 names: a note that cannot be signed and stored is refused
// `FIELD_VALUE_INVALID` naming `note`, like every other refusal of that code.
//
// #10, the queue and pickup half: a trashed task's work is not handed out.
// The queue does not list it and a pickup of its reservation answers in the
// same bytes as a reservation that does not exist. Restoring the task brings
// the work back.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { queue } from '../../packages/core-runtime/src/pickup.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('FR1-RUNTIME continuation', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('fr1r');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  const revisionOf = async (recordId: string): Promise<number> =>
    await c.count(`select revision::text as n from public.records where id = $1`, [recordId]);

  const queued = async (): Promise<readonly string[]> =>
    (await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => await queue(tx))).map(
      (entry) => entry.reservationId,
    );

  it.each([
    ['a NUL', `a${String.fromCodePoint(0)}b`],
    ['a lone surrogate', '\ud800'],
    ['a number', 5],
  ])(
    '#53: a note carrying %s is refused naming note',
    async (_, note) => {
      const task = await c.createTask('a decision with a bad note');
      const proposal = await c.propose(task.id, task.revision);
      const answer = await c.asPerson('task.decide', {
        gateId: proposal['gateId'],
        versionId: proposal['versionId'],
        decision: 'approve',
        note,
      });
      expect([answer.status, answer.body['code'], answer.body['names']]).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
        ['note'],
      ]);
    },
    60_000,
  );

  it("#10: a trashed task's work is not queued or picked up, and restore brings it back", async () => {
    const task = await c.createTask('work on a task that is trashed');
    const reservationId = await c.approve(await c.propose(task.id, task.revision));
    expect(await queued()).toContain(reservationId);

    const trashed = await c.asPerson('task.trash', {
      recordId: task.id,
      expectedRevision: await revisionOf(task.id),
    });
    expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);

    expect(await queued()).not.toContain(reservationId);
    const refused = await c.asAgent('task.pickup', { reservationId });
    const missing = await c.asAgent('task.pickup', { reservationId: randomUUID() });
    expect(refused.status).toBe(missing.status);
    expect(refused.body).toStrictEqual(missing.body);
    expect(
      await c.count(`select count(*)::text as n from public.leases where task_id = $1`, [task.id]),
    ).toBe(0);

    const restored = await c.asPerson('task.restore', {
      batchId: (trashed.body['detail'] as Record<string, unknown>)['batchId'],
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(await queued()).toContain(reservationId);
    const picked = await c.pickup(reservationId);
    expect(picked['reservationId']).toBe(reservationId);
  }, 60_000);
});
