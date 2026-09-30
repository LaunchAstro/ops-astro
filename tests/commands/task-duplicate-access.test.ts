// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 "Duplicate without contents": who may duplicate and what they learn.
// It needs task:write for the chosen client and current read on the old task,
// both asked inside the command; the carried text warning on the old client's
// name comes from the server on every path; and the new task's "duplicated
// from" event names the old task only to a reader who holds read on it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { grantTo, shareWithClient, type Member } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';
import {
  CANARY,
  CLIENT_A_ALIAS,
  CLIENT_A_NAME,
  ENTRIES,
  alpha,
  boardOf,
  clientA,
  clientB,
  db,
  detailOf,
  duplicate,
  footprint,
  newTaskOf,
  outcomeOf,
  owner,
  person,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-duplicate: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** Every (entry, caller, body) at once: refusals write nothing, so order does not matter. */
const everyPath = async (
  callers: readonly Member[],
  bodies: readonly Parameters<typeof duplicate>[1][],
) =>
  await Promise.all(
    ENTRIES.flatMap((entry) =>
      callers.flatMap((who) => bodies.map(async (body) => await duplicate(who, body, entry))),
    ),
  );

/** What `reader` is shown of the new task, the board and the old task. */
async function expectNoWayBack(reader: Member, taskId: string, old: string): Promise<void> {
  const read = await detailOf(reader, taskId);
  expect(isCommandRefusal(read)).toBe(false);
  for (const body of [read, await boardOf(reader)]) {
    expect(JSON.stringify(body)).not.toContain(old);
    expect(JSON.stringify(body)).not.toContain(CANARY);
  }
  expect(isCommandRefusal(read) || !('task' in read) ? null : read.task.history[0]).toMatchObject({
    operation: 'task.duplicate',
    duplicatedFrom: null,
  });
  // The old task, looked up directly, answers as a task that never was.
  const lookup = await detailOf(reader, old);
  const never = await detailOf(reader, randomUUID());
  expect(isCommandRefusal(lookup) ? lookup.code : 'served').toBe(
    isCommandRefusal(never) ? never.code : 'served',
  );
  expect(JSON.stringify(lookup)).not.toContain(CANARY);
}

describe.skipIf(serverUrl === undefined)(
  'MP-4-8 duplicate gives no way back to the old task',
  () => {
    it('MP-4-8 duplicate gives no way back to the old task', async () => {
      const old = await taskFor(alpha, owner, `${CANARY} old`, clientA);
      const { taskId } = newTaskOf(
        await duplicate(owner, { recordId: old, client: clientB, title: 'the new one' }),
      );
      // Client B's person, standing on a share of the new task (one grant).
      const clientPerson = await shareWithClient(db.app, alpha, owner, taskId);
      // An agency member who holds read on client B only (and on the new task).
      const member = await person('b-reader');
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, member, 'read', { kind: 'party', id: clientB });
        await grantTo(tx, member, 'read', { kind: 'record', id: taskId });
      });
      await expectNoWayBack(clientPerson, taskId, old);
      await expectNoWayBack(member, taskId, old);
      // A reader holding read on the old task is shown its id.
      const own = await detailOf(owner, taskId);
      expect(isCommandRefusal(own) || !('task' in own) ? null : own.task.history[0]).toMatchObject({
        operation: 'task.duplicate',
        duplicatedFrom: old,
      });
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'MP-4-8 duplicate refused without read on the old task',
  () => {
    it('MP-4-8 duplicate refused without read on the old task', async () => {
      const old = await taskFor(alpha, owner, 'held back', clientA);
      const [noRead, revoked] = [await person('no-read'), await person('revoked')];
      const readGrant = await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, noRead, 'write', { kind: 'party', id: clientB });
        await grantTo(tx, revoked, 'write', { kind: 'party', id: clientB });
        return await grantTo(tx, revoked, 'read', { kind: 'record', id: old });
      });
      // The draft opens while the read holds; it is revoked before the create.
      expect(isCommandRefusal(await detailOf(revoked, old))).toBe(false);
      await db.app.withBusiness(alpha, async (tx) => {
        await revokeGrant(tx, readGrant);
      });
      const before = await footprint();
      const answers = await everyPath(
        [noRead, revoked],
        [{ recordId: old, client: clientB, title: 'copy' }],
      );
      for (const answer of answers) {
        expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
        expect(JSON.stringify(answer)).not.toContain(old);
      }
      expect(await footprint()).toStrictEqual(before);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  "MP-4-8 carried text warns on the old client's name",
  () => {
    it("MP-4-8 carried text warns on the old client's name", async () => {
      const old = await taskFor(alpha, owner, `Refit for ${CLIENT_A_NAME}`, clientA);
      const body = {
        recordId: old,
        client: clientB,
        title: `Refit for ${CLIENT_A_NAME}`,
        stepNames: ['Measure up', `Call ${CLIENT_A_ALIAS} reception`],
      };
      const before = await footprint();
      for (const answer of await everyPath([owner], [body])) {
        expect(outcomeOf(answer)).toStrictEqual({
          code: 'CARRIED_TEXT_NAMES_CLIENT',
          names: ['stepNames.1', 'title'],
        });
        expect(JSON.stringify(answer)).not.toContain(CLIENT_A_NAME);
      }
      // Hostile spellings of the name are the name.
      const hostile = [
        `refit for ${CLIENT_A_NAME.toUpperCase()}`,
        'Refit for harbourline\tdental',
        'Refit for Harbour​line  Dental',
        'Refit for ＨＡＲＢＯＵＲＬＩＮＥ Dental',
      ].map((title) => ({ recordId: old, client: clientB, title }));
      for (const answer of await everyPath([owner], hostile)) {
        expect(outcomeOf(answer)).toStrictEqual({
          code: 'CARRIED_TEXT_NAMES_CLIENT',
          names: ['title'],
        });
      }
      expect(await footprint()).toStrictEqual(before);
      // Confirmed, it is created as sent; edited out, no warning at all.
      expect(outcomeOf(await duplicate(owner, { ...body, confirmCarried: true }))).toStrictEqual({
        applied: true,
      });
      const edited = { ...body, title: 'Refit', stepNames: ['Measure up', 'Call reception'] };
      expect(outcomeOf(await duplicate(owner, edited))).toStrictEqual({ applied: true });
    });
  },
);

describe.skipIf(serverUrl === undefined)('MP-4-8 refusal task:write for the chosen client', () => {
  it('MP-4-8 refusal task:write for the chosen client', async () => {
    const old = await taskFor(alpha, owner, 'the old task', clientA);
    const writerA = await person('writer-a');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, writerA, 'read', { kind: 'record', id: old });
      await grantTo(tx, writerA, 'write', { kind: 'party', id: clientA });
    });
    const before = await footprint();
    const bodies = [clientB, null].map((client) => ({ recordId: old, client, title: 'x' }));
    for (const answer of await everyPath([writerA], bodies)) {
      expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    }
    expect(await footprint()).toStrictEqual(before);
    // With write on client B, the same person makes it there.
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, writerA, 'write', { kind: 'party', id: clientB });
    });
    const made = await duplicate(writerA, { recordId: old, client: clientB, title: 'x' });
    expect(outcomeOf(made)).toStrictEqual({ applied: true });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 task.duplicate declaration and audit', () => {
  it('is declared a person-only task write with its two-part authority', () => {
    const declared = COMMAND_SURFACE.find((one) => String(one.name) === 'task.duplicate');
    expect([declared?.kind, declared?.action, declared?.agent, declared?.authority]).toStrictEqual([
      'write',
      'write',
      'never',
      ['task:read', 'task:write'],
    ]);
  });

  it('audits the create and the refusal, the old task never the subject', async () => {
    const old = await taskFor(alpha, owner, 'audited', clientA);
    const made = await duplicate(owner, { recordId: old, client: clientB, title: 'a' });
    const nobody = await person('nobody');
    await duplicate(nobody, { recordId: old, client: clientB, title: 'b' });
    const events = await db.admin.execute<{ outcome: string; subject_record_id: string | null }>(
      `select outcome, subject_record_id from public.audit_events
        where business_id = $1 and command = 'task.duplicate' and actor_id = any($2::uuid[])
        order by seq`,
      [alpha, [owner.actorId, nobody.actorId]],
    );
    expect(events.map((one) => one.subject_record_id)).not.toContain(old);
    expect(events.at(-2)).toEqual({
      outcome: 'applied',
      subject_record_id: newTaskOf(made).taskId,
    });
    expect(events.at(-1)).toEqual({ outcome: 'refused', subject_record_id: null });
  });
});
