// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9a: the three marks the derived rank reads (R70), and the one command
// that writes them.
//
// Impact, confidence and ease are whole numbers from 1 to 10 or absent, and
// absent is never 0 (ticket MP-4-9, Spec). They are task fields owned by
// `task.set_scores` under `task:write`, audited as `task scores changed`, and
// reached on the API and the command line through the surface row. The range is
// held twice: the command refuses by name before anything is written, and the
// database refuses a value the command never saw, so a projection that bypasses
// the command cannot store an 11.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, shareWithClient } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import {
  type Request,
  as,
  business,
  db,
  freshTask,
  outcomeOf,
  serverUrl,
  setUp,
  taskRow,
  tearDown,
  untouched,
  writer,
} from './scores-world.ts';

if (serverUrl === undefined) {
  console.warn('task-scores: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('is declared as a task write an agent reaches only inside its delegation', () => {
    // Found by name rather than through `declarationOf`, so the case compiles
    // and fails while the row is still missing.
    const row = COMMAND_SURFACE.find((declared) => String(declared.name) === 'task.set_scores');
    expect([row?.kind, row?.collection, row?.action, row?.authorisedOn, row?.agent]).toStrictEqual([
      'write',
      'task',
      'write',
      'record',
      'delegated',
    ]);
  });

  it('sets the three marks, and each lands in its own slot', async () => {
    const task = await freshTask('marked');
    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 7, confidence: 9, ease: 8 },
    });
    expect(outcomeOf(answer)).toStrictEqual({ applied: true });
    const row = await taskRow(task.recordId);
    expect([row?.impact, row?.confidence, row?.ease]).toStrictEqual(['7', '9', '8']);
  });

  it.each([
    ['0', { impact: 0 }, ['impact']],
    ['11', { confidence: 11 }, ['confidence']],
    ['a fraction', { ease: 2.5 }, ['ease']],
    ['a negative', { impact: -1 }, ['impact']],
  ])('refuses %s by name and writes nothing', async (_label, fields, names) => {
    const task = await freshTask('out of range');
    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields,
    });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names });
    expect(Number((await taskRow(task.recordId))?.revision)).toBe(task.revision);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('MP-4-9a isolation: business to business', async () => {
    const other = await insertBusiness(db.app, 'task-scores-other');
    await installSpine(db.app, other);
    const owner = await enrol(db.app, other, 'other-owner');
    await db.app.withBusiness(other, async (tx) => await grantTo(tx, owner, 'write'));
    const canary = `other-business-${randomUUID()}`;
    const made = await executeCommand(db.app, other, owner.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: canary },
    } as unknown as Request);
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    const theirs = made.recordId ?? '';

    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: theirs,
      expectedRevision: 1,
      fields: { impact: 9 },
    });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'NOT_FOUND', names: [] });
    expect(JSON.stringify(answer)).not.toContain(canary);
    await untouched(theirs, 1, other);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('MP-4-9a isolation: client to client', async () => {
    const mine = await freshTask('client A task');
    const canary = `client-b-${randomUUID()}`;
    const theirs = await freshTask(canary);
    const clientA = await shareWithClient(db.app, business, writer, mine.recordId);
    await shareWithClient(db.app, business, writer, theirs.recordId);

    // An external client writes nothing but a client-audience comment, so
    // even its own shared task keeps its marks; the other client's task is
    // not there at all.
    const own = await as(clientA, {
      command: 'task.set_scores',
      recordId: mine.recordId,
      expectedRevision: mine.revision,
      fields: { impact: 9 },
    });
    expect(isCommandRefusal(own)).toBe(true);
    const across = await as(clientA, {
      command: 'task.set_scores',
      recordId: theirs.recordId,
      expectedRevision: theirs.revision,
      fields: { impact: 9 },
    });
    const madeUp = await as(clientA, {
      command: 'task.set_scores',
      recordId: randomUUID(),
      expectedRevision: theirs.revision,
      fields: { impact: 9 },
    });
    // The other client's real task and an identifier that names nothing get
    // the same answer, so the refusal tells client A nothing about B.
    expect(isCommandRefusal(across)).toBe(true);
    expect(JSON.stringify(across)).toBe(JSON.stringify(madeUp));
    expect(JSON.stringify([own, across])).not.toContain(canary);
    await untouched(mine.recordId, mine.revision);
    await untouched(theirs.recordId, theirs.revision);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('MP-4-9a isolation: person to person, each holding write on their own task', async () => {
    const [pat, quinn] = [
      await enrol(db.app, business, 'pat'),
      await enrol(db.app, business, 'quinn'),
    ];
    const patsTask = await freshTask('pat task');
    const canary = `quinn-${randomUUID()}`;
    const quinnsTask = await freshTask(canary);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, pat, 'write', { kind: 'record', id: patsTask.recordId });
      await grantTo(tx, quinn, 'write', { kind: 'record', id: quinnsTask.recordId });
    });

    const own = await as(pat, {
      command: 'task.set_scores',
      recordId: patsTask.recordId,
      expectedRevision: patsTask.revision,
      fields: { ease: 3 },
    });
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    const across = await as(pat, {
      command: 'task.set_scores',
      recordId: quinnsTask.recordId,
      expectedRevision: quinnsTask.revision,
      fields: { ease: 3 },
    });
    expect(isCommandRefusal(across)).toBe(true);
    expect(JSON.stringify(across)).not.toContain(canary);
    await untouched(quinnsTask.recordId, quinnsTask.revision);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('holds the range in the database, whatever writes the row', async () => {
    const task = await freshTask('database');
    for (const value of [0, 11, 2.5]) {
      // Sequential: one row, and each attempt must be refused on its own.
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        db.admin.execute(
          `update public.records set data = data || jsonb_build_object('impact', $3::numeric)
            where business_id = $1 and id = $2`,
          [business, task.recordId, value],
        ),
        String(value),
      ).rejects.toThrow(/records_task_impact_is_a_mark/u);
    }
  });
});
