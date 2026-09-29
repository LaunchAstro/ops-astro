// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-1 (roadmap #634): task types and the map as a task, the map's components,
// client scope, and who may retype a ticket.
//
// One test per line of the ticket's supporting checklist, a refusal per
// permission key, and `WF-1 isolation` with its three crossings: another
// business, another client's map in the same business, and an agent under a
// live delegation. Every call goes through the envelopes the routes call.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { insertActor, insertLogin, insertMapping, insertPerson } from '../identity/fixture.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Made,
  type Member,
  type WayfinderWorld,
} from './world.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();

interface MapView {
  readonly id: string;
  readonly type: string;
  readonly owner: string | null;
  readonly client: string | null;
  readonly version: number;
  readonly destination: { readonly id: string; readonly text: string } | null;
  readonly notes: { readonly id: string; readonly text: string } | null;
  readonly fog: readonly { readonly id: string; readonly kind: string; readonly text: string }[];
  readonly outOfScope: readonly {
    readonly id: string;
    readonly kind: string;
    readonly text: string;
    readonly ticketId: string | null;
  }[];
  readonly decisions: readonly {
    readonly ticketId: string;
    readonly title: string;
    readonly gist: string | null;
  }[];
  readonly tickets: readonly { readonly id: string; readonly type: string }[];
  readonly versions: readonly { readonly version: number; readonly changed: readonly string[] }[];
}

const TYPES = ['map', 'research', 'prototype', 'grilling', 'task', 'build'] as const;

describe.skipIf(serverUrl === undefined)('WF-1 task types and the map as a task', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let teammate: Decider;
  let writer: Member;
  let reader: Member;

  const view = async (who: Member, recordId: string): Promise<MapView> => {
    const answer = (await w.read(who, { read: 'map.view', recordId })) as {
      readonly map?: MapView;
      readonly code?: string;
    };
    if (answer.map === undefined) throw new Error(`map.view refused ${String(answer.code)}`);
    return answer.map;
  };

  const revise = async (who: Member, map: string, change: Record<string, unknown>) =>
    await w.as(who, {
      command: 'map.revise',
      recordId: map,
      expectedRevision: await w.revisionOf(map),
      ...change,
    });

  const retype = async (who: Member, recordId: string, taskType: string) =>
    await w.as(who, {
      command: 'task.set_type',
      recordId,
      expectedRevision: await w.revisionOf(recordId),
      taskType,
    });

  const newMap = async (who: Member, title: string): Promise<Made> =>
    await w.create(who, { title }, { taskType: 'map' });

  const ticket = async (who: Member, map: string, title: string, taskType: string) =>
    await w.create(who, { title }, { taskType, parentId: map });

  beforeAll(async () => {
    w = await wayfinderWorld('wf1', 'wfone');
    owner = await w.decider('owner');
    teammate = await w.decider('teammate');
    writer = await w.member('writer', ['read', 'write']);
    reader = await w.member('reader', ['read']);
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('WF-1 type field takes map, research, prototype, grilling, task or build', async () => {
    const map = await newMap(owner, 'types map');
    const made: string[] = [];
    for (const taskType of TYPES.filter((t) => t !== 'map')) {
      made.push((await ticket(owner, map.id, `a ${taskType}`, taskType)).id);
    }
    const plain = await w.create(owner, { title: 'no type named' });
    const kinds = await w.db.admin.execute<{ readonly id: string; readonly kind: string }>(
      `select r.id, t.key as kind from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and r.id = any($2::uuid[])`,
      [w.business, [map.id, plain.id, ...made]],
    );
    // One record kind whatever the type: the type changes views and rules only.
    expect(new Set(kinds.map((row) => row.kind))).toStrictEqual(new Set(['task']));
    expect((await view(owner, map.id)).tickets.map((t) => t.type).toSorted()).toStrictEqual(
      ['build', 'grilling', 'prototype', 'research', 'task'].toSorted(),
    );
    const types = await w.db.admin.execute<{ readonly type: string | null }>(
      `select data->>'type' as type from public.records where business_id = $1 and id = $2`,
      [w.business, plain.id],
    );
    expect(types[0]?.type).toBe('task');

    const odd = await w.as(owner, {
      command: 'task.create',
      fields: { title: 'odd' },
      taskType: 'epic',
    });
    expect(codeOf(odd)).toBe('FIELD_VALUE_INVALID');
    // The type is the command's: a body cannot write it as a field.
    const smuggled = await w.as(owner, {
      command: 'task.create',
      fields: { title: 'smuggled', type: 'map' },
    });
    expect(codeOf(smuggled)).not.toBe('applied');
  });

  it("WF-1 a map's tickets are its subtasks, with no separate map record", async () => {
    const map = await newMap(owner, 'subtask map');
    const research = await ticket(owner, map.id, 'look it up', 'research');
    const parents = await w.db.admin.execute<{ readonly parent: string | null }>(
      `select data->>'parent' as parent from public.records where business_id = $1 and id = $2`,
      [w.business, research.id],
    );
    expect(parents[0]?.parent).toBe(map.id);
    expect((await view(owner, map.id)).tickets.map((t) => t.id)).toStrictEqual([research.id]);
    const types = await w.db.admin.execute<{ readonly key: string }>(
      `select key from public.record_types where business_id = $1 order by key`,
      [w.business],
    );
    expect(types.map((row) => row.key)).not.toContain('map');
    const tables = await w.db.admin.execute<{ readonly name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public' and table_name in ('maps', 'wayfinder_maps')`,
    );
    expect(tables).toStrictEqual([]);
  });

  it('WF-1 each component is typed; a fog patch and an out of scope item have their own ids', async () => {
    const map = await newMap(owner, 'components map');
    must(
      await revise(owner, map.id, {
        destination: 'A signed-off onboarding flow',
        notes: 'Reuse the intake form',
        addFog: ['Who approves?', 'Which emails?'],
        addOutOfScope: [{ text: 'Payments' }],
      }),
      'map.revise',
    );
    const shown = await view(owner, map.id);
    expect(shown.destination?.text).toBe('A signed-off onboarding flow');
    expect(shown.notes?.text).toBe('Reuse the intake form');
    expect(shown.fog.map((patch) => [patch.kind, patch.text])).toStrictEqual([
      ['fog', 'Who approves?'],
      ['fog', 'Which emails?'],
    ]);
    expect(shown.outOfScope.map((item) => [item.kind, item.text])).toStrictEqual([
      ['out_of_scope', 'Payments'],
    ]);
    const ids = [
      shown.destination?.id,
      shown.notes?.id,
      ...shown.fog.map((p) => p.id),
      ...shown.outOfScope.map((o) => o.id),
    ];
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/u);

    // A component kind the map does not have is refused, and nothing is written.
    const before = await view(owner, map.id);
    const odd = await revise(owner, map.id, { addFog: [''] });
    expect(codeOf(odd)).toBe('FIELD_VALUE_INVALID');
    expect((await view(owner, map.id)).version).toBe(before.version);
  });

  it('WF-1 decisions so far are rendered from resolved subtasks in closing order', async () => {
    const map = await newMap(owner, 'decisions map');
    const first = await ticket(owner, map.id, 'first asked', 'research');
    const second = await ticket(owner, map.id, 'second asked', 'research');
    await ticket(owner, map.id, 'still open', 'research');
    // Closed second first: the order is the closing order, not the creation order.
    for (const closed of [second, first]) {
      must(
        await w.as(owner, {
          command: 'task.complete',
          recordId: closed.id,
          expectedRevision: await w.revisionOf(closed.id),
        }),
        'task.complete',
      );
    }
    const shown = await view(owner, map.id);
    expect(shown.decisions.map((line) => [line.ticketId, line.title])).toStrictEqual([
      [second.id, 'second asked'],
      [first.id, 'first asked'],
    ]);
    // Stored once, on the ticket: the map's own record holds no decision text.
    const mapData = await w.db.admin.execute<{ readonly data: string }>(
      `select data::text as data from public.records where business_id = $1 and id = $2`,
      [w.business, map.id],
    );
    expect(mapData[0]?.data).not.toContain('second asked');
  });

  it('WF-1 map revised numbers the version and records which components changed', async () => {
    const map = await newMap(owner, 'versions map');
    must(await revise(owner, map.id, { destination: 'one', addFog: ['a patch'] }), 'first');
    const after1 = await view(owner, map.id);
    must(await revise(owner, map.id, { notes: 'two' }), 'second');
    const after2 = await view(owner, map.id);
    expect([after1.version, after2.version]).toStrictEqual([1, 2]);
    expect(after2.versions.map((v) => v.version)).toStrictEqual([1, 2]);
    expect(after2.versions[0]?.changed.toSorted()).toStrictEqual(
      [after1.destination?.id, after1.fog[0]?.id].toSorted(),
    );
    expect(after2.versions[1]?.changed).toStrictEqual([after2.notes?.id]);

    // A stale revision is refused and numbers nothing.
    const stale = await w.as(owner, {
      command: 'map.revise',
      recordId: map.id,
      expectedRevision: 1,
      notes: 'stale',
    });
    expect(codeOf(stale)).toBe('VERSION_STALE');
    expect((await view(owner, map.id)).version).toBe(2);
    // Revising a ticket that is not a map is refused.
    const research = await ticket(owner, map.id, 'not a map', 'research');
    expect(codeOf(await revise(owner, research.id, { notes: 'x' }))).toBe(
      'TRANSITION_NOT_PERMITTED',
    );
  });

  it('WF-1 a client-scoped map carries its client; a map, its tickets and threads never reach a client surface', async () => {
    const client = randomUUID();
    const map = await newMap(owner, 'client map');
    must(
      await w.as(owner, {
        command: 'map.scope',
        recordId: map.id,
        expectedRevision: await w.revisionOf(map.id),
        client,
      }),
      'map.scope',
    );
    const research = await ticket(owner, map.id, 'client research', 'research');
    expect((await view(owner, map.id)).client).toBe(client);
    const clients = await w.db.admin.execute<{ readonly client: string | null }>(
      `select data->>'client' as client from public.records where business_id = $1 and id = $2`,
      [w.business, research.id],
    );
    expect(clients[0]?.client).toBe(client);

    // Never client visible: the audience command refuses both.
    for (const id of [map.id, research.id]) {
      const shown = await w.as(owner, {
        command: 'task.set_audience',
        recordId: id,
        expectedRevision: await w.revisionOf(id),
        fields: { client_visible: true },
      });
      expect(codeOf(shown)).toBe('TRANSITION_NOT_PERMITTED');
    }
    // Never shared: a share of either is refused, and an outside party
    // holding a share row written behind the product's back reads NOT_FOUND.
    const subject = `client-${randomUUID()}`;
    const outside = await w.db.app.withBusiness(w.business, async (tx) => {
      const personId = await insertPerson(tx, subject);
      const actorId = await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      const sharer = { personId: owner.personId, actorId: owner.actorId };
      for (const recordId of [map.id, research.id]) {
        const shared = await shareRecord(tx, sharer, { collection: 'task', recordId, personId });
        expect(shared.ok).toBe(false);
      }
      return personId;
    });
    await w.db.admin.execute(
      `insert into public.grants (business_id, id, subject_kind, subject_id, scope_kind, scope_id,
          collection, action, can_delegate, may_permit_delegation, granted_by_actor_id)
       select $1, gen_random_uuid(), 'person', $2, 'record', id, 'task', 'read', false, false, $3
         from unnest($4::uuid[]) as id`,
      [w.business, outside, owner.actorId, [map.id, research.id]],
    );
    for (const recordId of [map.id, research.id]) {
      const read = await executeRead(w.db.app, w.business, { provider: 'supabase', subject }, {
        read: 'task.read',
        recordId,
      } as never);
      expect(codeOf(read)).toBe('NOT_FOUND');
      expect(JSON.stringify(read)).not.toContain('client research');
    }
  });

  it('WF-1 the map summary read model is kept current in the writing transaction', async () => {
    const summary = async (map: string) =>
      (
        await w.db.admin.execute<{
          readonly version: number;
          readonly open_tickets: number;
          readonly closed_tickets: number;
          readonly fog: number;
          readonly out_of_scope: number;
        }>(
          `select version, open_tickets, closed_tickets, fog, out_of_scope
             from public.map_summaries where business_id = $1 and map_id = $2`,
          [w.business, map],
        )
      )[0];
    const map = await newMap(owner, 'summary map');
    expect(await summary(map.id)).toStrictEqual({
      version: 0,
      open_tickets: 0,
      closed_tickets: 0,
      fog: 0,
      out_of_scope: 0,
    });
    must(
      await revise(owner, map.id, { addFog: ['p1', 'p2'], addOutOfScope: [{ text: 'o' }] }),
      'r',
    );
    const t = await ticket(owner, map.id, 'counted', 'research');
    await ticket(owner, map.id, 'counted too', 'task');
    expect(await summary(map.id)).toStrictEqual({
      version: 1,
      open_tickets: 2,
      closed_tickets: 0,
      fog: 2,
      out_of_scope: 1,
    });
    must(
      await w.as(owner, {
        command: 'task.complete',
        recordId: t.id,
        expectedRevision: await w.revisionOf(t.id),
      }),
      'complete',
    );
    expect((await summary(map.id))?.closed_tickets).toBe(1);
    expect((await summary(map.id))?.open_tickets).toBe(1);
  });

  it('WF-1 each tracked action is written by its command in the same transaction and audited', async () => {
    const map = await newMap(owner, 'audited map');
    const before = (await w.audit()).length;
    const revised = await revise(owner, map.id, { destination: 'audited' });
    const scoped = await w.as(owner, {
      command: 'map.scope',
      recordId: map.id,
      expectedRevision: await w.revisionOf(map.id),
      client: randomUUID(),
    });
    const research = await ticket(owner, map.id, 'audited research', 'research');
    const retyped = await retype(owner, research.id, 'grilling');
    for (const result of [revised, scoped, retyped]) expect(codeOf(result)).toBe('applied');
    const lines = (await w.audit()).slice(before);
    expect(lines.map((l) => [l.command, l.outcome, l.subject])).toStrictEqual([
      ['map.revise', 'applied', map.id],
      ['map.scope', 'applied', map.id],
      ['task.create', 'applied', research.id],
      ['task.set_type', 'applied', research.id],
    ]);
    // The retype is recorded on the ticket itself as well as in the chain.
    const history = await w.db.admin.execute<{ readonly history: string }>(
      `select data->'type_history' as history from public.records where business_id = $1 and id = $2`,
      [w.business, research.id],
    );
    expect(JSON.stringify(history[0]?.history)).toContain('grilling');
    // A refused revise leaves no version row and no summary change.
    const versions = async () =>
      (
        await w.db.admin.execute<{ readonly n: string }>(
          `select count(*)::text as n from public.map_versions where business_id = $1 and map_id = $2`,
          [w.business, map.id],
        )
      )[0]?.n;
    const count = await versions();
    expect(codeOf(await revise(reader, map.id, { notes: 'refused' }))).toBe('SCOPE_NOT_GRANTED');
    expect(await versions()).toBe(count);
  });

  it('WF-1 refuses each permission key it names to a caller without it', async () => {
    const map = await newMap(owner, 'keys map');
    const research = await ticket(owner, map.id, 'keys research', 'research');
    // task:write: create, map revised, map scoped.
    expect(
      codeOf(
        await w.as(reader, { command: 'task.create', fields: { title: 'x' }, taskType: 'map' }),
      ),
    ).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await revise(reader, map.id, { notes: 'x' }))).toBe('SCOPE_NOT_GRANTED');
    expect(
      codeOf(
        await w.as(reader, {
          command: 'map.scope',
          recordId: map.id,
          expectedRevision: await w.revisionOf(map.id),
          client: randomUUID(),
        }),
      ),
    ).toBe('SCOPE_NOT_GRANTED');
    // task:decide: a retype to grilling by a writer without decide.
    const refused = await retype(writer, research.id, 'grilling');
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(refused)).toContain('task:decide');
    // A plain retype (research to task) is task:write, which the writer holds.
    expect(codeOf(await retype(writer, research.id, 'task'))).toBe('applied');
  });

  it('WF-1 retype owner only', async () => {
    const map = await newMap(owner, 'owner map');
    const research = await ticket(owner, map.id, 'to be grilled', 'research');
    // The teammate holds task:decide but is not the map's owner.
    const byTeammate = await retype(teammate, research.id, 'grilling');
    expect(codeOf(byTeammate)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(byTeammate)).toContain('map owner');
    expect((await view(owner, map.id)).tickets[0]?.type).toBe('research');
    expect(codeOf(await retype(owner, research.id, 'grilling'))).toBe('applied');
    expect((await view(owner, map.id)).tickets[0]?.type).toBe('grilling');
    // From grilling is guarded too.
    expect(codeOf(await retype(teammate, research.id, 'task'))).toBe('SCOPE_NOT_GRANTED');
    // The map's owner is its creator, recorded on the map.
    expect((await view(owner, map.id)).owner).toBe(owner.personId);
  });

  it('WF-1 retype agent refused', async () => {
    const map = await newMap(owner, 'agent map');
    const picked = await w.pickUp(owner, 'an agent works this');
    must(
      await w.as(owner, {
        command: 'task.reparent',
        recordId: picked.taskId,
        expectedRevision: await w.revisionOf(picked.taskId),
        parentId: map.id,
      }),
      'reparent',
    );
    must(await retype(owner, picked.taskId, 'grilling'), 'owner retype');
    const byAgent = await w.asAgent(
      {
        command: 'task.set_type',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: await w.revisionOf(picked.taskId),
        taskType: 'research',
      },
      picked.credential,
    );
    expect(codeOf(byAgent)).not.toBe('applied');
    const type = await w.db.admin.execute<{ readonly type: string }>(
      `select data->>'type' as type from public.records where business_id = $1 and id = $2`,
      [w.business, picked.taskId],
    );
    expect(type[0]?.type).toBe('grilling');
    const trail = (await w.audit()).filter(
      (l) => l.command === 'task.set_type' && l.subject === picked.taskId,
    );
    expect(trail.at(-1)?.outcome).toBe('refused');
  });

  it('WF-1 isolation', async () => {
    // Map A for client X, map B for client Y, one record-scoped grant each.
    const mapA = await newMap(owner, 'canary-map-A');
    const mapB = await newMap(owner, 'canary-map-B');
    for (const [map, client] of [
      [mapA.id, randomUUID()],
      [mapB.id, randomUUID()],
    ] as const) {
      must(
        await w.as(owner, {
          command: 'map.scope',
          recordId: map,
          expectedRevision: await w.revisionOf(map),
          client,
        }),
        'scope',
      );
    }
    const ticketB = await ticket(owner, mapB.id, 'canary-ticket-B', 'research');
    must(await revise(owner, mapB.id, { addFog: ['canary-fog-B'] }), 'fog B');
    const onA = await w.member('on-a', ['read', 'write', 'decide'], {
      kind: 'record',
      id: mapA.id,
    });
    const bea = await w.outsider('bea');
    const beaMap = await w.create(bea, { title: 'bravo map' }, { taskType: 'map' }, w.bravo);

    const foreign = [mapB.id, ticketB.id, 'canary-map-B', 'canary-ticket-B', 'canary-fog-B'];
    const clean = (answer: unknown) => {
      const text = JSON.stringify(answer);
      for (const canary of foreign) expect(text).not.toContain(canary);
    };

    // 1. Another business: bravo's person cannot read, revise or retype alpha's.
    for (const answer of [
      await w.read(bea, { read: 'map.view', recordId: mapB.id }, w.bravo),
      await w.as(
        bea,
        { command: 'map.revise', recordId: mapB.id, expectedRevision: 1, notes: 'x' },
        w.bravo,
      ),
      await w.as(
        bea,
        { command: 'task.set_type', recordId: ticketB.id, expectedRevision: 1, taskType: 'task' },
        w.bravo,
      ),
    ]) {
      expect(codeOf(answer)).toBe('NOT_FOUND');
      clean(answer);
    }
    // And alpha's owner cannot reach bravo's map from alpha.
    expect(codeOf(await w.read(owner, { read: 'map.view', recordId: beaMap.id }))).toBe(
      'NOT_FOUND',
    );

    // 2. Another client in the same business: the map-A holder reaches map A
    // and its tickets, never map B, its ticket or its fog, nor their count.
    expect((await view(onA, mapA.id)).id).toBe(mapA.id);
    const research = await ticket(onA, mapA.id, 'A research', 'research');
    expect(codeOf(await retype(onA, research.id, 'task'))).toBe('applied');
    for (const answer of [
      await w.read(onA, { read: 'map.view', recordId: mapB.id }),
      await revise(onA, mapB.id, { notes: 'x' }),
      await retype(onA, ticketB.id, 'task'),
      await w.as(onA, {
        command: 'task.create',
        fields: { title: 'x' },
        taskType: 'research',
        parentId: mapB.id,
      }),
    ]) {
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
      clean(answer);
    }

    // 3. An agent under a live delegation on a ticket of map A: map B is
    // outside its purpose, and so is map A's own body.
    const picked = await w.pickUp(owner, 'delegated work');
    must(
      await w.as(owner, {
        command: 'task.reparent',
        recordId: picked.taskId,
        expectedRevision: await w.revisionOf(picked.taskId),
        parentId: mapA.id,
      }),
      'reparent',
    );
    for (const answer of [
      await w.asAgent(
        {
          command: 'task.set_type',
          operationId: randomUUID(),
          recordId: ticketB.id,
          expectedRevision: await w.revisionOf(ticketB.id),
          taskType: 'task',
        },
        picked.credential,
      ),
      await w.asAgent(
        {
          command: 'map.revise',
          operationId: randomUUID(),
          recordId: mapB.id,
          expectedRevision: await w.revisionOf(mapB.id),
          notes: 'x',
        },
        picked.credential,
      ),
    ]) {
      expect(codeOf(answer)).not.toBe('applied');
      clean(answer);
    }
    // Map B is unchanged by every crossing.
    expect((await view(owner, mapB.id)).version).toBe(1);
    expect((await view(owner, mapB.id)).tickets.map((t) => t.type)).toStrictEqual(['research']);
  });
});
