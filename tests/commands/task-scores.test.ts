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
import type { Hono } from 'hono';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createEmptyDatabase,
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-scores: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Request = Parameters<typeof executeCommand>[4];

const outcomeOf = (answer: CommandResult) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  let db: FreshDatabase;
  let business: string;
  let writer: Member;
  let reader: Member;

  const as = async (member: Member, command: Readonly<Record<string, unknown>>) =>
    await executeCommand(db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...command,
    } as unknown as Request);

  const taskRow = async (recordId: string, where = business) =>
    (
      await db.admin.execute<{
        readonly revision: string;
        readonly impact: string | null;
        readonly confidence: string | null;
        readonly ease: string | null;
      }>(
        `select revision::text as revision, num_3::text as impact, num_4::text as confidence,
                num_5::text as ease
           from public.records where business_id = $1 and id = $2`,
        [where, recordId],
      )
    )[0];

  const freshTask = async (title: string, by: Member = writer) => {
    const made = await as(by, { command: 'task.create', fields: { title } });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    const recordId = made.recordId ?? '';
    return { recordId, revision: Number((await taskRow(recordId))?.revision) };
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's' });
    business = await insertBusiness(db.app, 'task-scores');
    await installSpine(db.app, business);
    writer = await enrol(db.app, business, 'writer');
    reader = await enrol(db.app, business, 'reader');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, writer, 'write');
      // Only so the client crossing can share one task with each client.
      await grantTo(tx, writer, 'share');
      await grantTo(tx, reader, 'read');
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

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

  it.each([
    ['a numeric string', { impact: '7' }, ['impact=numeric']],
    ['a boolean', { confidence: true }, ['confidence=numeric']],
    ['an array', { ease: [7] }, ['ease=numeric']],
    ['an object', { impact: { value: 7 } }, ['impact=numeric']],
    ['negative zero', { ease: -0 }, ['ease']],
    ['just over the top', { confidence: 10.000001 }, ['confidence']],
  ])('refuses %s as a mark and writes nothing', async (_label, fields, names) => {
    const task = await freshTask('hostile');
    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields,
    });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names });
    expect(Number((await taskRow(task.recordId))?.revision)).toBe(task.revision);
  });

  it('lets one of two writes at the same revision apply, and refuses the other stale', async () => {
    const task = await freshTask('two at once');
    const [first, second] = await Promise.all(
      [3, 9].map(
        async (impact) =>
          await as(writer, {
            command: 'task.set_scores',
            recordId: task.recordId,
            expectedRevision: task.revision,
            fields: { impact },
          }),
      ),
    );
    const outcomes = [first, second].map((answer) =>
      answer === undefined || isCommandRefusal(answer) ? answer?.code : 'applied',
    );
    expect(outcomes.toSorted()).toStrictEqual(['VERSION_STALE', 'applied']);
    const row = await taskRow(task.recordId);
    expect(row?.revision).toBe(String(task.revision + 1));
    expect(['3', '9']).toContain(row?.impact);
  });

  it('clears a mark with null, so a mark can go back to absent and never to 0', async () => {
    const task = await freshTask('cleared');
    const set = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 5, confidence: 7 },
    });
    expect(outcomeOf(set)).toStrictEqual({ applied: true });
    const cleared = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision + 1,
      fields: { impact: null },
    });
    expect(outcomeOf(cleared)).toStrictEqual({ applied: true });
    const row = await taskRow(task.recordId);
    expect([row?.impact, row?.confidence, row?.ease]).toStrictEqual([null, '7', null]);
  });

  it('refuses a caller without task:write and writes nothing', async () => {
    const task = await freshTask('read only');
    const answer = await as(reader, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 3 },
    });
    expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect((await taskRow(task.recordId))?.impact).toBeNull();
  });

  it('owns the marks: task.update is refused and names the owning command', async () => {
    const task = await freshTask('generic');
    const answer = await as(writer, {
      command: 'task.update',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { ease: 4 },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['ease=task.set_scores'],
    });
  });

  it('refuses a field it does not own, so a mark change cannot carry another', async () => {
    const task = await freshTask('stray');
    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 4, title: 'renamed' },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['title=task.update'],
    });
  });

  it('audits the change and the refusal as task.set_scores', async () => {
    const task = await freshTask('audited');
    const [applied, refusal] = [randomUUID(), randomUUID()];
    await as(writer, {
      command: 'task.set_scores',
      operationId: applied,
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { ease: 6 },
    });
    await as(reader, {
      command: 'task.set_scores',
      operationId: refusal,
      recordId: task.recordId,
      expectedRevision: task.revision + 1,
      fields: { ease: 2 },
    });
    const events = await db.admin.execute<{
      readonly actor_id: string;
      readonly outcome: string;
      readonly refusal_code: string | null;
    }>(
      `select actor_id, outcome, refusal_code from public.audit_events
        where business_id = $1 and command = 'task.set_scores' and operation_id = any($2::text[])
        order by seq`,
      [business, [applied, refusal]],
    );
    // `toEqual`: the driver's rows are not plain objects.
    expect(events).toEqual([
      { actor_id: writer.actorId, outcome: 'applied', refusal_code: null },
      { actor_id: reader.actorId, outcome: 'refused', refusal_code: 'SCOPE_NOT_GRANTED' },
    ]);
  });

  // Data separation (owner rule): one crossing per boundary, each aimed at a
  // real task whose title is a canary that no answer may carry, and each
  // leaving the foreign task's marks and revision exactly as they were.
  const untouched = async (recordId: string, revision: number, where = business) => {
    const row = await taskRow(recordId, where);
    expect([row?.revision, row?.impact, row?.confidence, row?.ease]).toStrictEqual([
      String(revision),
      null,
      null,
      null,
    ]);
  };

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

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command on the API and command line', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let credential: string;

  beforeAll(async () => {
    fixture = await createApiFixture('s');
    api = fixture.compose();
    credential = await tokenFor(fixture.member.presented.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it('sets the marks through the route and through the generated command line', async () => {
    const created = await post(
      api,
      `/api/b/${BUSINESS_KEY}/task/create`,
      { operationId: randomUUID(), fields: { title: 'marked on every surface' } },
      authorised(credential),
    );
    expect(created.status).toBe(200);
    const recordId = String(created.body['recordId']);

    const route = await post(
      api,
      `/api/b/${BUSINESS_KEY}/task/set_scores`,
      {
        operationId: randomUUID(),
        recordId,
        expectedRevision: Number(created.body['revision']),
        fields: { impact: 7, confidence: 9 },
      },
      authorised(credential),
    );
    expect(route.status, JSON.stringify(route.body)).toBe(200);

    const transport: Transport = async (path, body, bearer) =>
      await api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body,
        }),
      );
    const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential });
    const line = await cli.run('task.set_scores', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number(route.body['revision']),
      fields: { ease: 11 },
    });
    const refusal = line.body as Readonly<Record<string, unknown>>;
    expect([line.status, refusal['code'], refusal['names']]).toStrictEqual([
      422,
      'FIELD_VALUE_INVALID',
      ['ease'],
    ]);

    const applied = await cli.run('task.set_scores', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number(route.body['revision']),
      fields: { ease: 8 },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command for an agent', () => {
  let world: AgentWorld;

  beforeAll(async () => {
    world = await agentWorld('s', 'task-scores-agent');
  }, 120_000);

  afterAll(async () => {
    await world?.drop();
  });

  const revisionOf = async (recordId: string) =>
    Number(
      (
        await world.db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from public.records where business_id = $1 and id = $2`,
          [world.business, recordId],
        )
      )[0]?.revision,
    );

  it('sets the marks on its own picked-up task, inside its delegation', async () => {
    const decider = await world.decider('scores-decider');
    const picked = await world.pickUp(decider, 'an agent marks this');
    const revision = await revisionOf(picked.taskId);

    const stale = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision - 1,
        fields: { impact: 4 },
      },
      picked.credential,
    );
    expect(codeOf(stale)).toBe('VERSION_STALE');

    const outside = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision,
        fields: { impact: 0 },
      },
      picked.credential,
    );
    expect(codeOf(outside)).toBe('FIELD_VALUE_INVALID');

    const applied = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision,
        fields: { impact: 4, confidence: 5, ease: 6 },
      },
      picked.credential,
    );
    expect(codeOf(applied)).toBe('not-a-refusal');
    expect(await revisionOf(picked.taskId)).toBe(revision + 1);
  });

  it('MP-4-9a isolation: person to person, under a live delegation', async () => {
    const ada = await world.decider('scores-ada');
    const bo = await world.decider('scores-bo');
    const picked = await world.pickUp(ada, 'ada delegated this task');
    const canary = `bo-${randomUUID()}`;
    const bos = await world.asPerson(bo, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: canary },
    });
    if (isCommandRefusal(bos)) throw new Error(`create refused ${bos.code}`);
    const before = await revisionOf(bos.recordId ?? '');

    const answer = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: bos.recordId,
        expectedRevision: before,
        fields: { impact: 4 },
      },
      picked.credential,
    );
    expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(answer)).not.toContain(canary);
    expect(await revisionOf(bos.recordId ?? '')).toBe(before);
  });

  it('cannot reach a task outside its delegation', async () => {
    const decider = await world.decider('scores-other');
    const picked = await world.pickUp(decider, 'the delegated task');
    const other = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'not the agent task' },
    });
    if (isCommandRefusal(other)) throw new Error(`create refused ${other.code}`);
    const answer = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: other.recordId,
        expectedRevision: 1,
        fields: { impact: 4 },
      },
      picked.credential,
    );
    expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(await revisionOf(other.recordId ?? '')).toBe(1);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command over an upgrade', () => {
  let db: EmptyDatabase | undefined;

  afterAll(async () => {
    await db?.drop();
  });

  it('moves a preset field already keyed impact aside, values and all', async () => {
    const migrations = readMigrations('migrations');
    const marks = migrations.findIndex((migration) => migration.version === '0032_task_marks');
    db = await createEmptyDatabase({ part: 'sup' });
    await applyMigrations(db.admin, migrations.slice(0, marks));
    const business = await insertBusiness(db.app, 'task-scores-upgrade');
    const spine = await installSpine(db.app, business);
    const writer = await enrol(db.app, business, 'writer');
    await db.app.withBusiness(business, async (tx) => await grantTo(tx, writer, 'write'));
    // The installer here already declares the marks, so they are removed to
    // stand for a business installed before them, which then synced its own
    // `impact` as a note.
    await db.admin.execute(
      `delete from public.field_defs
        where business_id = $1 and record_type_id = $2
          and key in ('impact', 'confidence', 'ease')`,
      [business, spine.taskTypeId],
    );
    await db.admin.execute(
      `insert into public.field_defs
         (business_id, id, record_type_id, key, label, value_type, slot,
          write_mode, owning_operation, visibility_class, origin)
       values ($1, gen_random_uuid(), $2, 'impact', 'Impact note', 'text', null,
               'generic', null, 'internal', 'preset')`,
      [business, spine.taskTypeId],
    );
    const noted = await executeCommand(db.app, business, writer.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'noted before the upgrade', impact: 'big for the launch' },
    } as unknown as Request);
    if (isCommandRefusal(noted)) throw new Error(`create refused ${noted.code}`);

    await db.closeSessions();
    await applyMigrations(db.admin, migrations);

    const fields = await db.admin.execute<{ readonly key: string; readonly origin: string }>(
      `select key, origin from public.field_defs
        where business_id = $1 and record_type_id = $2 and key like '%impact'
        order by key`,
      [business, spine.taskTypeId],
    );
    expect(fields.map((row) => `${row.key}:${row.origin}`)).toStrictEqual([
      'impact:core',
      'preset_impact:preset',
    ]);
    const data = await db.admin.execute<{ readonly data: Record<string, unknown> }>(
      `select data from public.records where business_id = $1 and id = $2`,
      [business, noted.recordId],
    );
    expect(data[0]?.data['preset_impact']).toBe('big for the launch');
    expect('impact' in (data[0]?.data ?? {})).toBe(false);

    const scored = await executeCommand(db.app, business, writer.presented, 'api', {
      command: 'task.set_scores',
      operationId: randomUUID(),
      recordId: noted.recordId,
      expectedRevision: (noted.revision ?? 1) + 1,
      fields: { impact: 7 },
    } as unknown as Request);
    expect(outcomeOf(scored)).toStrictEqual({ applied: true });
  }, 180_000);
});
