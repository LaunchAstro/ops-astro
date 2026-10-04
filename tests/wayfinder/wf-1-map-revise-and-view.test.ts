// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wayfinderWorld, must, codeOf, type WayfinderWorld, type Decider } from './world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

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
});
