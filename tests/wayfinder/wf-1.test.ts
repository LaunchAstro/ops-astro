// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one suite per ticket: each case is a checklist line on one shared world */
//
// WF-1 (roadmap #634): task types and the map as a task, the map's summary
// read model, client scope, and who may retype a ticket. The map's components,
// versions and its view (`map.revise`, `map.view`) are their own suite.
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
import { addClient, grantTo } from '../commands/fixture.ts';
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

const TYPES = ['map', 'research', 'prototype', 'grilling', 'task', 'build'] as const;

describe.skipIf(serverUrl === undefined)('WF-1 task types and the map as a task', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let teammate: Decider;
  let writer: Member;
  let reader: Member;
  let sharer: Member;

  /** The tickets filed under a map, oldest first, with their types. */
  const ticketsOf = async (map: string) =>
    await w.db.admin.execute<{ readonly id: string; readonly type: string | null }>(
      `select id::text as id, data->>'type' as type from public.records
        where business_id = $1 and data->>'parent' = $2 order by created_at, id`,
      [w.business, map],
    );

  const dataOf = async (recordId: string, key: string) =>
    (
      await w.db.admin.execute<{ readonly value: string | null }>(
        `select data->>$3 as value from public.records where business_id = $1 and id = $2`,
        [w.business, recordId, key],
      )
    )[0]?.value;

  const retype = async (who: Member, recordId: string, taskType: string) =>
    await w.as(who, {
      command: 'task.set_type',
      recordId,
      expectedRevision: await w.revisionOf(recordId),
      taskType,
    });

  const newMap = async (who: Member, title: string): Promise<Made> =>
    await w.create(who, { title }, { taskType: 'map' });

  /** A real client of the business: `map.scope`, like `task.set_party`, names only one. */
  const newClient = async (): Promise<string> => {
    const id = randomUUID();
    await addClient(w.db.app, w.business, id, owner);
    return id;
  };

  const ticket = async (who: Member, map: string, title: string, taskType: string) =>
    await w.create(who, { title }, { taskType, parentId: map });

  beforeAll(async () => {
    w = await wayfinderWorld('wf1', 'wfone');
    owner = await w.decider('owner');
    teammate = await w.decider('teammate');
    writer = await w.member('writer', ['read', 'write']);
    reader = await w.member('reader', ['read']);
    sharer = await w.member('sharer', ['read', 'write', 'share']);
    // A map's client is a client change, asked under `share` like `task.set_party`.
    await w.grant(owner, 'share');
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
    expect((await ticketsOf(map.id)).map((t) => t.type).toSorted()).toStrictEqual(
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
    expect((await ticketsOf(map.id)).map((t) => t.id)).toStrictEqual([research.id]);
    const types = await w.db.admin.execute<{ readonly key: string }>(
      `select key from public.record_types where business_id = $1 order by key`,
      [w.business],
    );
    expect(types.map((row) => row.key)).not.toContain('map');
    const tables = await w.db.admin.execute<{ readonly name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public' and table_name in ('maps', 'wayfinder_maps')`,
    );
    expect(tables).toHaveLength(0);
  });

  it('WF-1 a client-scoped map carries its client; a map, its tickets and threads never reach a client surface', async () => {
    const client = await newClient();
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
    expect(await dataOf(map.id, 'client')).toBe(client);
    const clients = await w.db.admin.execute<{ readonly client: string | null }>(
      `select data->>'client' as client from public.records where business_id = $1 and id = $2`,
      [w.business, research.id],
    );
    expect(clients[0]?.client).toBe(client);

    // Never client visible: the audience command refuses both.
    for (const id of [map.id, research.id]) {
      const shown = await w.as(sharer, {
        command: 'task.set_audience',
        recordId: id,
        expectedRevision: await w.revisionOf(id),
        fields: { client_visible: true },
      });
      expect(codeOf(shown)).toBe('TRANSITION_NOT_PERMITTED');
    }
    // Never shared: a share of either is refused, and an outside party
    // holding a share row written behind the product's back reads NOT_FOUND.
    const plain = await w.create(owner, { title: 'a plain task, shareable' });
    const subject = `client-${randomUUID()}`;
    const outside = await w.db.app.withBusiness(w.business, async (tx) => {
      const personId = await insertPerson(tx, subject);
      const actorId = await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      const by = { personId: sharer.personId, actorId: sharer.actorId };
      for (const recordId of [map.id, research.id]) {
        const shared = await shareRecord(tx, by, { collection: 'task', recordId, personId });
        expect(shared.ok).toBe(false);
      }
      // The control: the same sharer shares a plain task, so the refusal above is the map's.
      const control = await shareRecord(tx, by, {
        collection: 'task',
        recordId: plain.id,
        personId,
      });
      expect(control.ok).toBe(true);
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
    const t = await ticket(owner, map.id, 'counted', 'research');
    await ticket(owner, map.id, 'counted too', 'task');
    expect(await summary(map.id)).toStrictEqual({
      version: 0,
      open_tickets: 2,
      closed_tickets: 0,
      fog: 0,
      out_of_scope: 0,
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
    // A ticket moved off the map leaves its count in the same transaction.
    const other = await newMap(owner, 'summary map, the other');
    const moved = await ticket(owner, map.id, 'moved away', 'task');
    expect((await summary(map.id))?.open_tickets).toBe(2);
    must(
      await w.as(owner, {
        command: 'task.reparent',
        recordId: moved.id,
        expectedRevision: await w.revisionOf(moved.id),
        parentId: other.id,
      }),
      'reparent',
    );
    expect((await summary(map.id))?.open_tickets).toBe(1);
    expect((await summary(other.id))?.open_tickets).toBe(1);
    // A task that is not a map has no summary row.
    const plain = await w.create(owner, { title: 'not a map' });
    expect(await summary(plain.id)).toBeUndefined();
  });

  it('WF-1 each tracked action is written by its command in the same transaction and audited', async () => {
    const map = await newMap(owner, 'audited map');
    const before = (await w.audit()).length;
    const scoped = await w.as(owner, {
      command: 'map.scope',
      recordId: map.id,
      expectedRevision: await w.revisionOf(map.id),
      client: await newClient(),
    });
    const research = await ticket(owner, map.id, 'audited research', 'research');
    const retyped = await retype(owner, research.id, 'grilling');
    for (const result of [scoped, retyped]) expect(codeOf(result)).toBe('applied');
    const lines = (await w.audit()).slice(before);
    expect(lines.map((l) => [l.command, l.outcome, l.subject])).toStrictEqual([
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
    // A refused scope writes nothing: the client stays, the revision stays,
    // and the refusal is audited.
    const client = await dataOf(map.id, 'client');
    const revision = await w.revisionOf(map.id);
    const refused = await w.as(reader, {
      command: 'map.scope',
      recordId: map.id,
      expectedRevision: revision,
      client: randomUUID(),
    });
    expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
    expect(await dataOf(map.id, 'client')).toBe(client);
    expect(await w.revisionOf(map.id)).toBe(revision);
    expect((await w.audit()).at(-1)).toMatchObject({ command: 'map.scope', outcome: 'refused' });
  });

  it('WF-1 refuses each permission key it names to a caller without it', async () => {
    const map = await newMap(owner, 'keys map');
    const research = await ticket(owner, map.id, 'keys research', 'research');
    // task:write: create, map scoped.
    expect(
      codeOf(
        await w.as(reader, { command: 'task.create', fields: { title: 'x' }, taskType: 'map' }),
      ),
    ).toBe('SCOPE_NOT_GRANTED');
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
    expect((await ticketsOf(map.id))[0]?.type).toBe('research');
    expect(codeOf(await retype(owner, research.id, 'grilling'))).toBe('applied');
    expect((await ticketsOf(map.id))[0]?.type).toBe('grilling');
    // From grilling is guarded too.
    expect(codeOf(await retype(teammate, research.id, 'task'))).toBe('SCOPE_NOT_GRANTED');
    // The map's owner is its creator, recorded on the map.
    expect(await dataOf(map.id, 'map_owner')).toBe(owner.personId);
    // Nor by the side door: detaching the ticket from its map (to retype it
    // ownerless and file it back) is the owner's too, and moves nothing.
    const detached = await w.as(teammate, {
      command: 'task.reparent',
      recordId: research.id,
      expectedRevision: await w.revisionOf(research.id),
      parentId: null,
    });
    expect(codeOf(detached)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(detached)).toContain('map owner');
    expect(await dataOf(research.id, 'parent')).toBe(map.id);
    expect(await dataOf(research.id, 'type')).toBe('grilling');
  });

  it('WF-1 map scoped follows the client rules of task.set_party', async () => {
    const scope = async (who: Member, map: string, client: unknown) =>
      await w.as(who, {
        command: 'map.scope',
        recordId: map,
        expectedRevision: await w.revisionOf(map),
        client,
      });
    const map = await newMap(owner, 'rules map');
    // A client change asks share, which a writer does not hold.
    expect(codeOf(await scope(writer, map.id, await newClient()))).toBe('SCOPE_NOT_GRANTED');
    // Only a client of this business, never a made-up identifier.
    const unknown = await scope(owner, map.id, randomUUID());
    expect(codeOf(unknown)).toBe('NOT_FOUND');
    expect(await dataOf(map.id, 'client')).toBeNull();
    // While the map is empty its client can be corrected or cleared, as an
    // empty task's can: a scope is a client change, not content.
    must(await scope(owner, map.id, await newClient()), 'a first, wrong client');
    must(await scope(owner, map.id, null), 'cleared');
    expect(await dataOf(map.id, 'client')).toBeNull();
    // Once the map has a ticket it has content, so its client is locked (S0-5).
    const client = await newClient();
    must(await scope(owner, map.id, client), 'scope while empty');
    await ticket(owner, map.id, 'content now', 'research');
    const revision = await w.revisionOf(map.id);
    const locked = await scope(owner, map.id, await newClient());
    expect(codeOf(locked)).toBe('CLIENT_LOCKED');
    expect(await dataOf(map.id, 'client')).toBe(client);
    expect(await w.revisionOf(map.id)).toBe(revision);
    // Only a map is scoped this way.
    const plain = await w.create(owner, { title: 'not a map either' });
    expect(codeOf(await scope(owner, plain.id, client))).toBe('TRANSITION_NOT_PERMITTED');
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
    const agentOperation = randomUUID();
    const refusedRetypes = async () =>
      (await w.audit()).filter(
        (l) =>
          l.command === 'task.set_type' &&
          l.outcome === 'refused' &&
          l.code === 'DELEGATION_EXCLUDES_OPERATION',
      ).length;
    const before = await refusedRetypes();
    const byAgent = await w.asAgent(
      {
        command: 'task.set_type',
        operationId: agentOperation,
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
    // Refused at the agent surface and audited: until the agent credential
    // (API-2) gives an agent task:write on a map, no agent retype reaches the
    // handler, and a guarded one never will (the handler asks task:decide).
    expect(codeOf(byAgent)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await refusedRetypes()).toBe(before + 1);
  });

  it('WF-1 isolation', async () => {
    // Map A for client X, map B for client Y, one record-scoped grant each.
    const mapA = await newMap(owner, 'canary-map-A');
    const mapB = await newMap(owner, 'canary-map-B');
    const clientB = await newClient();
    for (const [map, client] of [
      [mapA.id, await newClient()],
      [mapB.id, clientB],
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
    const revisionsB = [await w.revisionOf(mapB.id), await w.revisionOf(ticketB.id)];
    const onA = await w.member('on-a', ['read', 'write', 'decide'], {
      kind: 'record',
      id: mapA.id,
    });
    const bea = await w.outsider('bea');
    // `share` too in bravo, so a scope from there is answered by the lookup,
    // not by the missing grant: the crossing, not the key, is under test.
    await w.db.app.withBusiness(w.bravo, async (tx) => await grantTo(tx, bea, 'share'));
    await w.create(bea, { title: 'bravo map' }, { taskType: 'map' }, w.bravo);

    const foreign = [mapB.id, ticketB.id, clientB, 'canary-map-B', 'canary-ticket-B'];
    const clean = (answer: unknown) => {
      const text = JSON.stringify(answer);
      for (const canary of foreign) expect(text).not.toContain(canary);
    };
    const scopeB = { command: 'map.scope', recordId: mapB.id, client: await newClient() };

    // 1. Another business: bravo's person cannot scope or retype alpha's.
    for (const answer of [
      await w.as(bea, { ...scopeB, expectedRevision: revisionsB[0] }, w.bravo),
      await w.as(
        bea,
        {
          command: 'task.set_type',
          recordId: ticketB.id,
          expectedRevision: revisionsB[1],
          taskType: 'task',
        },
        w.bravo,
      ),
    ]) {
      expect(codeOf(answer)).toBe('NOT_FOUND');
      clean(answer);
    }

    // 2. Another client in the same business: the map-A holder files and
    // retypes map A's tickets, never map B's, its ticket or a ticket under it.
    const research = await ticket(onA, mapA.id, 'A research', 'research');
    expect(codeOf(await retype(onA, research.id, 'task'))).toBe('applied');
    // The map's grant covers a task filed under the map, not one under its ticket.
    const under = await w.as(onA, {
      command: 'task.create',
      fields: { title: 'under the ticket' },
      parentId: research.id,
    });
    expect(codeOf(under)).toBe('SCOPE_NOT_GRANTED');
    for (const answer of [
      await w.as(onA, { ...scopeB, expectedRevision: await w.revisionOf(mapB.id) }),
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
    // outside its purpose, and so is retyping or scoping anything.
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
        { ...scopeB, operationId: randomUUID(), expectedRevision: await w.revisionOf(mapB.id) },
        picked.credential,
      ),
    ]) {
      expect(codeOf(answer)).not.toBe('applied');
      clean(answer);
    }
    // Map B and its ticket are unchanged by every crossing.
    expect([await w.revisionOf(mapB.id), await w.revisionOf(ticketB.id)]).toStrictEqual(revisionsB);
    expect(await dataOf(mapB.id, 'client')).toBe(clientB);
    expect((await ticketsOf(mapB.id)).map((t) => t.type)).toStrictEqual(['research']);
  });
});
