// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- the review's proofs, kept as written on one shared world each */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wayfinderWorld, must, codeOf, type WayfinderWorld, type Decider } from './world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { createApi } from '../../apps/api/app.ts';
import type { SecuritySignal } from '../../apps/api/alerts/detect.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';

describe('WF-1 map revise and view, under review proofs', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  beforeAll(async () => {
    w = await wayfinderWorld('sol379', 'sol379');
    owner = await w.decider('owner');
  }, 180_000);
  afterAll(async () => await w?.drop());
  const map = async (title: string) => await w.create(owner, { title }, { taskType: 'map' });
  const revise = async (id: string, change: Readonly<Record<string, unknown>>) =>
    await w.as(owner, {
      command: 'map.revise',
      recordId: id,
      expectedRevision: await w.revisionOf(id),
      ...change,
    });
  const complete = async (id: string) =>
    must(
      await w.as(owner, {
        command: 'task.complete',
        recordId: id,
        expectedRevision: await w.revisionOf(id),
      }),
      'complete ticket',
    );
  const linkOutOfScope = async (mapId: string, ticketId: string) =>
    must(
      await w.as(owner, {
        command: 'map.revise',
        recordId: mapId,
        expectedRevision: await w.revisionOf(mapId),
        addOutOfScope: [{ text: 'Excluded work', ticketId }],
      }),
      'link closed ticket',
    );

  it('WF-1 person to person separation hides a nested map linked from out of scope', async () => {
    const parent = await map('parent map');
    const nested = await w.create(
      owner,
      { title: 'private nested map' },
      { taskType: 'map', parentId: parent.id },
    );
    const reader = await w.member('parent-reader', ['read'], { kind: 'record', id: parent.id });
    expect(codeOf(await w.read(reader, { read: 'map.view', recordId: nested.id }))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    must(
      await w.as(owner, {
        command: 'task.complete',
        recordId: nested.id,
        expectedRevision: await w.revisionOf(nested.id),
      }),
      'complete the nested map',
    );
    // If insertion is refused, the subsequent read must still hide the nested id.
    await revise(parent.id, { addOutOfScope: [{ text: 'excluded work', ticketId: nested.id }] });
    const answer = await w.read(reader, { read: 'map.view', recordId: parent.id });
    expect(JSON.stringify(answer)).not.toContain(nested.id);
  });

  it('WF-1 a trashed map cannot acquire a new version', async () => {
    const made = await map('trashed map');
    must(
      await w.as(owner, {
        command: 'task.trash',
        recordId: made.id,
        expectedRevision: await w.revisionOf(made.id),
      }),
      'trash',
    );
    expect(codeOf(await w.read(owner, { read: 'map.view', recordId: made.id }))).toBe('NOT_FOUND');
    const before = await w.revisionOf(made.id);
    const answer = await revise(made.id, { notes: 'written after trash' });
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(await w.revisionOf(made.id)).toBe(before);
  });

  it.each([
    ['destination', { destination: 'a\u0000b' }],
    ['notes', { notes: 'a\u0000b' }],
    ['addFog', { addFog: ['a\u0000b'] }],
    ['addOutOfScope', { addOutOfScope: [{ text: 'a\u0000b' }] }],
  ] as const)('WF-1 %s containing NUL returns a typed refusal', async (_name, change) => {
    const made = await map('invalid component text');
    await expect(revise(made.id, change)).resolves.toMatchObject({ code: 'FIELD_VALUE_INVALID' });
  });

  it('WF-1 out of scope links only closed tickets', async () => {
    const made = await map('closed tickets only');
    const open = await w.create(
      owner,
      { title: 'still in progress' },
      { taskType: 'research', parentId: made.id },
    );
    const answer = await revise(made.id, {
      addOutOfScope: [{ text: 'excluded', ticketId: open.id }],
    });
    expect(codeOf(answer)).not.toBe('applied');
  });

  function intercept(
    after: (sql: string, parameters: readonly unknown[]) => Promise<void>,
  ): Database {
    return {
      ...w.db.app,
      async withBusiness(businessId, run) {
        return await w.db.app.withBusiness(businessId, async (tx) => {
          const wrapped: typeof tx = {
            ...tx,
            async query<Row>(sql: string, parameters: readonly unknown[] = []) {
              const rows = await tx.query<Row>(sql, parameters);
              await after(sql, parameters);
              return rows;
            },
          };
          return await run(wrapped);
        });
      },
    };
  }

  it('WF-1 a map view uses one committed revision during concurrent revise', async () => {
    const made = await map('snapshot');
    must(await revise(made.id, { destination: 'version one' }), 'first revise');
    const oldRevision = await w.revisionOf(made.id);
    let fired = false;
    const db = intercept(async (sql) => {
      if (fired || !sql.includes('left join public.map_summaries')) return;
      fired = true;
      must(
        await w.asOnSecond(owner, {
          command: 'map.revise',
          recordId: made.id,
          expectedRevision: oldRevision,
          destination: 'version two',
        }),
        'concurrent revise',
      );
    });
    const answer = await executeRead(db, w.business, owner.presented, {
      read: 'map.view',
      recordId: made.id,
    });
    expect(fired).toBe(true);
    if (!('map' in answer)) throw new Error('map.view was refused');
    expect(answer.map.version).toBe(answer.map.versions.at(-1)?.version);
  });

  it('WF-1 concurrent revisions and identical retries create one version', async () => {
    const made = await map('concurrent version');
    const request = {
      command: 'map.revise',
      operationId: randomUUID(),
      recordId: made.id,
      expectedRevision: await w.revisionOf(made.id),
      notes: 'one numbered change',
    };
    const answers = await Promise.all([w.as(owner, request), w.asOnSecond(owner, request)]);
    expect(answers.map((answer) => codeOf(answer))).toStrictEqual(['applied', 'applied']);
    expect(answers[0]).toStrictEqual(answers[1]);
    const shown = await w.read(owner, { read: 'map.view', recordId: made.id });
    expect(shown).toMatchObject({ ok: true, map: { version: 1, versions: [{ version: 1 }] } });
    const conflict = {
      command: 'map.revise',
      recordId: made.id,
      expectedRevision: await w.revisionOf(made.id),
      notes: 'a distinct change',
    };
    const results = await Promise.all([w.as(owner, conflict), w.asOnSecond(owner, conflict)]);
    expect(results.map((result) => codeOf(result)).toSorted()).toStrictEqual([
      'VERSION_STALE',
      'applied',
    ]);
  });

  it('WF-1 replaced and retired components remain in numbered history', async () => {
    const made = await map('retirement history');
    must(
      await revise(made.id, { destination: 'first destination', addFog: ['first fog'] }),
      'first',
    );
    const first = await w.read(owner, { read: 'map.view', recordId: made.id });
    if (typeof first !== 'object' || first === null || !('map' in first)) throw new Error('no map');
    const old = (first as { map: { destination: { id: string }; fog: { id: string }[] } }).map;
    const retired = old.fog[0]?.id;
    must(await revise(made.id, { destination: 'second destination', retire: [retired] }), 'second');
    const shown = await w.read(owner, { read: 'map.view', recordId: made.id });
    expect(shown).toMatchObject({
      map: { version: 2, destination: { text: 'second destination' }, fog: [] },
    });
    const rows = await w.db.admin.execute<{
      id: string;
      body: string;
      retired_version: number | null;
    }>(
      'select id, body, retired_version from public.map_components where business_id=$1 and map_id=$2',
      [w.business, made.id],
    );
    expect(rows).toContainEqual({
      id: old.destination.id,
      body: 'first destination',
      retired_version: 2,
    });
    expect(rows).toContainEqual({ id: retired, body: 'first fog', retired_version: 2 });
  });

  it('WF-1 person to person separation hides an out-of-scope ticket after it becomes a nested map', async () => {
    const parent = await map('parent');
    const ticket = await w.create(owner, { title: 'later private map' }, { parentId: parent.id });
    await complete(ticket.id);
    await linkOutOfScope(parent.id, ticket.id);
    const reader = await w.member('parent-only', ['read'], { kind: 'record', id: parent.id });
    must(
      await w.as(owner, {
        command: 'task.set_type',
        recordId: ticket.id,
        expectedRevision: await w.revisionOf(ticket.id),
        taskType: 'map',
      }),
      'retype linked ticket to map',
    );
    expect(codeOf(await w.read(reader, { read: 'map.view', recordId: ticket.id }))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    const answer = await w.read(reader, { read: 'map.view', recordId: parent.id });
    expect(codeOf(answer)).toBe('applied');
    expect(JSON.stringify(answer)).not.toContain(ticket.id);
  });

  it('WF-1 person to person separation hides an out-of-scope ticket moved to an inaccessible map', async () => {
    const a = await map('map A');
    const b = await map('private map B');
    const ticket = await w.create(owner, { title: 'closed work' }, { parentId: a.id });
    await complete(ticket.id);
    await linkOutOfScope(a.id, ticket.id);
    must(
      await w.as(owner, {
        command: 'task.reparent',
        recordId: ticket.id,
        expectedRevision: await w.revisionOf(ticket.id),
        parentId: b.id,
      }),
      'move linked ticket to private map',
    );
    const reader = await w.member('only-A', ['read'], { kind: 'record', id: a.id });
    expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    const answer = await w.read(reader, { read: 'map.view', recordId: a.id });
    expect(codeOf(answer)).toBe('applied');
    expect(JSON.stringify(answer)).not.toContain(ticket.id);
  });

  it('WF-1 person to person separation hides a nested map used as a ticket blocker', async () => {
    const parent = await map('blocker parent');
    const nested = await w.create(
      owner,
      { title: 'private nested blocker' },
      { parentId: parent.id, taskType: 'map' },
    );
    const ticket = await w.create(owner, { title: 'blocked ticket' }, { parentId: parent.id });
    await w.db.app.withBusiness(w.business, async (tx) => {
      await tx.query(
        `insert into public.record_links
        (business_id, id, link_type, from_record_id, to_record_id)
        values ($1, $2, 'blocks', $3, $4)`,
        [w.business, randomUUID(), nested.id, ticket.id],
      );
    });
    const reader = await w.member('blocker-parent-only', ['read'], {
      kind: 'record',
      id: parent.id,
    });
    expect(codeOf(await w.read(reader, { read: 'task.read', recordId: nested.id }))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    const answer = await w.read(reader, { read: 'map.view', recordId: parent.id });
    expect(codeOf(answer)).toBe('applied');
    expect(JSON.stringify(answer)).not.toContain(nested.id);
  });
});

describe('WF-1 map reads: parent retype, cancelled tickets and download volume', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  beforeAll(async () => {
    w = await wayfinderWorld('solp15fix2', 'solp15fix2');
    owner = await w.decider('owner');
  }, 180_000);
  afterAll(async () => await w?.drop());

  it('WF-1 person to person map view cannot read child content written after its parent ceases to be a map', async () => {
    const map = await w.create(owner, { title: 'map before retype' }, { taskType: 'map' });
    const child = await w.create(
      owner,
      { title: 'previously readable ticket' },
      { parentId: map.id },
    );
    const reader = await w.member('only-parent', ['read'], { kind: 'record', id: map.id });
    expect(codeOf(await w.read(reader, { read: 'task.read', recordId: child.id }))).toBe('applied');
    let fired = false;
    const db: Database = {
      ...w.db.app,
      async withBusiness(businessId, run) {
        return await w.db.app.withBusiness(
          businessId,
          async (tx) =>
            await run({
              ...tx,
              async query<Row>(sql: string, parameters: readonly unknown[] = []) {
                const rows = await tx.query<Row>(sql, parameters);
                if (!fired && sql.includes('left join public.map_summaries')) {
                  fired = true;
                  must(
                    await w.asOnSecond(owner, {
                      command: 'task.set_type',
                      recordId: map.id,
                      expectedRevision: await w.revisionOf(map.id),
                      taskType: 'task',
                    }),
                    'retype parent away from map',
                  );
                  must(
                    await w.asOnSecond(owner, {
                      command: 'task.update',
                      recordId: child.id,
                      expectedRevision: await w.revisionOf(child.id),
                      fields: { title: 'PRIVATE-CHILD-AFTER-PARENT-RETYPE' },
                    }),
                    'write child after inherited access ended',
                  );
                }
                return rows;
              },
            }),
        );
      },
    };
    const answer = await executeRead(db, w.business, reader.presented, {
      read: 'map.view',
      recordId: map.id,
    });
    expect(fired).toBe(true);
    expect(codeOf(await w.read(reader, { read: 'task.read', recordId: child.id }))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(JSON.stringify(answer)).not.toContain('PRIVATE-CHILD-AFTER-PARENT-RETYPE');
  });

  it('WF-1 the frontier omits a cancelled ticket', async () => {
    const map = await w.create(owner, { title: 'cancelled frontier' }, { taskType: 'map' });
    const ticket = await w.create(owner, { title: 'cancelled work' }, { parentId: map.id });
    expect(await w.read(owner, { read: 'map.frontier', recordId: map.id })).toMatchObject({
      ok: true,
      frontier: [{ id: ticket.id }],
    });
    const cancelled = await w.db.app.withBusiness(w.business, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `insert into records (business_id, id, record_type_id, data)
         select $1, gen_random_uuid(), id,
                '{"key":"cancelled","label":"Cancelled","machine_category":"cancelled","position":6000}'::jsonb
           from record_types where business_id = $1 and key = 'task_state'
         returning id`,
        [w.business],
      );
      const state = rows[0];
      if (state === undefined) throw new Error('cancelled state was not installed');
      return state.id;
    });
    must(
      await w.as(owner, {
        command: 'task.set_state',
        recordId: ticket.id,
        expectedRevision: await w.revisionOf(ticket.id),
        stateId: cancelled,
      }),
      'move ticket to the installed cancelled state',
    );
    const answer = await w.read(owner, { read: 'map.frontier', recordId: map.id });
    expect(answer).toMatchObject({ ok: true, frontier: [] });
  });

  it.each(['task.read', 'map.view', 'map.frontier'] as const)(
    'WF-1 %s contributes to download-volume detection',
    async (read) => {
      const map = await w.create(owner, { title: 'downloaded map' }, { taskType: 'map' });
      const ticket = await w.create(owner, { title: 'downloaded ticket' }, { parentId: map.id });
      const signals: SecuritySignal[] = [];
      const api = createApi({
        database: w.db.app,
        // oxlint-disable-next-line eslint/require-await -- the reviewer's proof, kept as written
        verify: async () => owner.presented,
        // oxlint-disable-next-line eslint/require-await -- the reviewer's proof, kept as written
        resolveBusiness: async (key) => (key === 'solp15fix2' ? w.business : undefined),
        executeCommand,
        executeRead,
        observe: (signal) => signals.push(signal),
      });
      const download = async (recordId: string): Promise<string> => {
        signals.length = 0;
        const response = await api.fetch(
          new Request(`http://api.test${PREFIX.person}solp15fix2${pathOf(read)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ recordId }),
          }),
        );
        expect(response.status).toBe(200);
        return await response.text();
      };
      expect(await download(map.id)).toContain(ticket.id);
      expect(signals.some((signal) => signal.kind === 'export' && signal.items > 0)).toBe(true);
      // Security review 1, M2: a map with fog and an empty frontier still hands out its fog.
      const foggy = await w.create(owner, { title: 'fog only map' }, { taskType: 'map' });
      must(
        await w.as(owner, {
          command: 'map.revise',
          recordId: foggy.id,
          expectedRevision: await w.revisionOf(foggy.id),
          addFog: ['FOG-ONLY-PATCH'],
        }),
        'add fog',
      );
      await download(foggy.id);
      expect(signals.some((signal) => signal.kind === 'export' && signal.items > 0)).toBe(true);
    },
  );
});
