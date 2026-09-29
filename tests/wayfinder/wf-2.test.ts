// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one suite per ticket: each case is a checklist line on one shared world */
//
// WF-2 (roadmap #635): the wayfinder commands and read models. Charting,
// claiming, blocking, graduating fog, resolving and closing as out of scope;
// the frontier and fog read models, kept in the writing transaction.
//
// One test per supporting-checklist line, a refusal per permission key, and
// `WF-2 isolation` with its three crossings. Every call goes through the
// envelopes the routes call.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  codeOf,
  must,
  wayfinderWorld,
  type Decider,
  type Member,
  type WayfinderWorld,
} from './world.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();

interface Frontier {
  readonly frontier: readonly {
    readonly id: string;
    readonly title: string;
    readonly type: string;
  }[];
  readonly fog: readonly { readonly id: string; readonly text: string }[];
}

describe.skipIf(serverUrl === undefined)('WF-2 wayfinder commands and read models', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let teammate: Decider;
  let writer: Member;
  let assigner: Member;
  let reader: Member;

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  const chart = async (who: Member, body: Record<string, unknown>) =>
    await w.as(who, { command: 'map.chart', ...body });

  const charted = async (who: Member, body: Record<string, unknown>) => {
    const answer = await chart(who, body);
    const made = must(answer, 'map.chart');
    const tickets = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets;
    return { map: made.id, tickets: tickets ?? {} };
  };

  const frontierOf = async (who: Member, map: string): Promise<Frontier> => {
    const answer = (await w.read(who, { read: 'map.frontier', recordId: map })) as Frontier & {
      code?: string;
    };
    if (answer.frontier === undefined)
      throw new Error(`map.frontier refused ${String(answer.code)}`);
    return answer;
  };

  /** The frontier as the read model holds it, straight from the table. */
  const frontierRows = async (map: string) =>
    (
      await w.db.admin.execute<{ readonly ticket_id: string }>(
        `select ticket_id from public.map_frontier where business_id = $1 and map_id = $2
          order by position`,
        [w.business, map],
      )
    ).map((row) => row.ticket_id);

  const claim = async (who: Member, id: string) =>
    await w.as(who, { command: 'task.claim', ...(await at(id)) });
  const resolve = async (who: Member, id: string, gist = 'a one-line gist') =>
    await w.as(who, { command: 'task.resolve', ...(await at(id)), answer: 'the answer', gist });
  const block = async (who: Member, id: string, blockedBy: readonly string[]) =>
    await w.as(who, { command: 'task.set_blocking', ...(await at(id)), blockedBy });

  beforeAll(async () => {
    w = await wayfinderWorld('wf2', 'wftwo');
    owner = await w.decider('owner');
    teammate = await w.decider('teammate');
    // Claiming is task:assign, which the deciders hold beside decide.
    await w.grant(owner, 'assign');
    await w.grant(teammate, 'assign');
    writer = await w.member('writer', ['read', 'write']);
    assigner = await w.member('assigner', ['read', 'assign']);
    reader = await w.member('reader', ['read']);
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('WF-2 chart', async () => {
    const { map, tickets } = await charted(owner, {
      title: 'charted map',
      destination: 'where we are going',
      notes: 'what we know',
      tickets: [
        { ref: 'a', title: 'find the rules', type: 'research' },
        { ref: 'b', title: 'choose the flow', type: 'grilling', blockedBy: ['a'] },
      ],
      fog: ['unknown one', 'unknown two'],
    });
    const view = (await w.read(owner, { read: 'map.view', recordId: map })) as {
      map: {
        destination: { text: string };
        notes: { text: string };
        fog: readonly { text: string }[];
        tickets: readonly { id: string; type: string; state: string }[];
        decisions: readonly unknown[];
      };
    };
    expect(view.map.destination.text).toBe('where we are going');
    expect(view.map.notes.text).toBe('what we know');
    expect(view.map.fog.map((p) => p.text)).toStrictEqual(['unknown one', 'unknown two']);
    expect(view.map.tickets.map((t) => t.type)).toStrictEqual(['research', 'grilling']);
    // It resolves nothing.
    expect(view.map.decisions).toStrictEqual([]);
    const links = await w.db.admin.execute<{
      readonly from_record_id: string;
      readonly to_record_id: string;
    }>(
      `select from_record_id, to_record_id from public.record_links
        where business_id = $1 and link_type = 'blocks' and to_record_id = $2`,
      [w.business, tickets['b']],
    );
    expect(links.map((l) => l.from_record_id)).toStrictEqual([tickets['a']]);
    // A ticket blocked by a ref the chart does not name is refused, and nothing is filed.
    const before = (
      await w.db.admin.execute<{ n: string }>(`select count(*)::text as n from public.records`)
    )[0]?.n;
    const bad = await chart(owner, {
      title: 'bad chart',
      tickets: [{ ref: 'a', title: 't', type: 'research', blockedBy: ['nope'] }],
    });
    expect(codeOf(bad)).toBe('FIELD_VALUE_INVALID');
    const after = (
      await w.db.admin.execute<{ n: string }>(`select count(*)::text as n from public.records`)
    )[0]?.n;
    expect(after).toBe(before);
  });

  it('WF-2 claim is first-come: a second claim on a claimed ticket is refused', async () => {
    const { tickets } = await charted(owner, {
      title: 'claim map',
      tickets: [{ ref: 'a', title: 'claim me', type: 'research' }],
    });
    const id = tickets['a'] as string;
    expect(codeOf(await claim(owner, id))).toBe('applied');
    const second = await claim(teammate, id);
    expect(codeOf(second)).toBe('TRANSITION_NOT_PERMITTED');
    const rows = await w.db.admin.execute<{ readonly assignee: string }>(
      `select data->>'assignee' as assignee from public.records where business_id = $1 and id = $2`,
      [w.business, id],
    );
    expect(rows[0]?.assignee).toBe(owner.personId);
    // Two claims at once: exactly one lands.
    const { tickets: race } = await charted(owner, {
      title: 'race map',
      tickets: [{ ref: 'a', title: 'raced', type: 'research' }],
    });
    const raced = race['a'] as string;
    const revision = await w.revisionOf(raced);
    const answers = await Promise.all([
      w.as(owner, { command: 'task.claim', recordId: raced, expectedRevision: revision }),
      w.asOnSecond(teammate, {
        command: 'task.claim',
        recordId: raced,
        expectedRevision: revision,
      }),
    ]);
    expect(answers.map((a) => codeOf(a)).toSorted()).toStrictEqual(['VERSION_STALE', 'applied']);
  });

  it('WF-2 the frontier holds exactly the open, unblocked, unclaimed tickets, in order, updated in the writing transaction', async () => {
    const { map, tickets } = await charted(owner, {
      title: 'frontier map',
      tickets: [
        { ref: 'a', title: 'first', type: 'research' },
        { ref: 'b', title: 'blocked by first', type: 'task', blockedBy: ['a'] },
        { ref: 'c', title: 'third', type: 'research' },
        { ref: 'd', title: 'to be claimed', type: 'task' },
      ],
    });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((ref) => tickets[ref] as string);
    expect(await frontierRows(map)).toStrictEqual([a, c, d]);
    must(await claim(owner, d as string), 'claim');
    expect(await frontierRows(map)).toStrictEqual([a, c]);
    must(await resolve(owner, a as string), 'resolve');
    // Resolving the blocker unblocks b; a has left.
    expect(await frontierRows(map)).toStrictEqual([b, c]);
    // The read answers the read model, in its order.
    expect((await frontierOf(owner, map)).frontier.map((t) => t.id)).toStrictEqual([b, c]);
  });

  it('WF-2 ticket blocking set: blockers are tickets of the same map, and a cycle is refused', async () => {
    const { map, tickets } = await charted(owner, {
      title: 'blocking map',
      tickets: [
        { ref: 'a', title: 'a', type: 'research' },
        { ref: 'b', title: 'b', type: 'research' },
      ],
    });
    const [a, b] = [tickets['a'] as string, tickets['b'] as string];
    must(await block(writer, b, [a]), 'block');
    expect(await frontierRows(map)).toStrictEqual([a]);
    // The set is kept on the ticket as a list, not as text holding one.
    const kept = await w.db.admin.execute<{ readonly kind: string; readonly first: string }>(
      `select jsonb_typeof(data->'blocked_by') as kind, data->'blocked_by'->>0 as first
         from public.records where business_id = $1 and id = $2`,
      [w.business, b],
    );
    expect(kept[0]).toStrictEqual({ kind: 'array', first: a });
    expect(codeOf(await block(writer, a, [b]))).toBe('TRANSITION_NOT_PERMITTED');
    expect(codeOf(await block(writer, a, [a]))).toBe('TRANSITION_NOT_PERMITTED');
    const other = await charted(owner, {
      title: 'other',
      tickets: [{ ref: 'x', title: 'x', type: 'task' }],
    });
    expect(codeOf(await block(writer, a, [other.tickets['x'] as string]))).toBe('NOT_FOUND');
    // Clearing the set unblocks.
    must(await block(writer, b, []), 'clear');
    expect(await frontierRows(map)).toStrictEqual([a, b]);
  });

  it('WF-2 two blocking sets at once cannot close a cycle between them', async () => {
    const { tickets } = await charted(owner, {
      title: 'race blocking map',
      tickets: [
        { ref: 'a', title: 'a', type: 'research' },
        { ref: 'b', title: 'b', type: 'research' },
      ],
    });
    const [a, b] = [tickets['a'] as string, tickets['b'] as string];
    const [atA, atB] = [await at(a), await at(b)];
    // a blocked by b, and b blocked by a, sent together: the wayfinder.map
    // lock makes one wait for the other's commit, and the second sees the cycle.
    const answers = await Promise.all([
      w.as(writer, { command: 'task.set_blocking', ...atA, blockedBy: [b] }),
      w.asOnSecond(writer, { command: 'task.set_blocking', ...atB, blockedBy: [a] }),
    ]);
    expect(answers.map((x) => codeOf(x)).toSorted()).toStrictEqual([
      'TRANSITION_NOT_PERMITTED',
      'applied',
    ]);
    const links = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.record_links
        where business_id = $1 and link_type = 'blocks' and to_record_id = any($2::uuid[])`,
      [w.business, [a, b]],
    );
    expect(links[0]?.n).toBe('1');
  });

  it('WF-2 graduating a patch names the patch and the tickets it became, and the patch leaves the fog', async () => {
    const { map } = await charted(owner, { title: 'fog map', fog: ['stays', 'graduates'] });
    const before = await frontierOf(owner, map);
    const patch = before.fog.find((p) => p.text === 'graduates')?.id as string;
    const graduated = await w.as(owner, {
      command: 'map.graduate',
      ...(await at(map)),
      patchId: patch,
      tickets: [
        { title: 'from the fog one', type: 'research' },
        { title: 'from the fog two', type: 'task' },
      ],
    });
    must(graduated, 'map.graduate');
    const made = (graduated as { detail?: { tickets?: string[] } }).detail?.tickets ?? [];
    expect(made).toHaveLength(2);
    const after = await frontierOf(owner, map);
    expect(after.fog.map((p) => p.text)).toStrictEqual(['stays']);
    expect(after.frontier.map((t) => t.id)).toStrictEqual(made);
    const row = await w.db.admin.execute<{ readonly graduated_into: string[] }>(
      `select graduated_into from public.map_components where business_id = $1 and id = $2`,
      [w.business, patch],
    );
    expect(row[0]?.graduated_into).toStrictEqual(made);
    // A patch already graduated cannot graduate again.
    const again = await w.as(owner, {
      command: 'map.graduate',
      ...(await at(map)),
      patchId: patch,
      tickets: [{ title: 'x', type: 'task' }],
    });
    expect(codeOf(again)).toBe('NOT_FOUND');
  });

  it("WF-2 resolving a grilling or prototype ticket is the map owner's alone", async () => {
    const { map, tickets } = await charted(owner, {
      title: 'resolve map',
      tickets: [
        { ref: 'g', title: 'which way', type: 'grilling' },
        { ref: 'p', title: 'try it', type: 'prototype' },
        { ref: 'r', title: 'look it up', type: 'research' },
      ],
    });
    for (const ref of ['g', 'p']) {
      const refused = await resolve(teammate, tickets[ref] as string);
      expect(codeOf(refused)).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(refused)).toContain('map owner');
    }
    // A writer without decide is refused on the key.
    const noDecide = await resolve(writer, tickets['g'] as string);
    expect(codeOf(noDecide)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(noDecide)).toContain('task:decide');
    // Research is task:write: the writer resolves it.
    expect(codeOf(await resolve(writer, tickets['r'] as string, 'found it'))).toBe('applied');
    expect(codeOf(await resolve(owner, tickets['g'] as string, 'this way'))).toBe('applied');
    const view = (await w.read(owner, { read: 'map.view', recordId: map })) as {
      map: { decisions: readonly { ticketId: string; gist: string }[] };
    };
    expect(view.map.decisions.map((d) => [d.ticketId, d.gist])).toStrictEqual([
      [tickets['r'], 'found it'],
      [tickets['g'], 'this way'],
    ]);
    // Resolve asks for the answer and a one-line gist.
    const noGist = await w.as(owner, {
      command: 'task.resolve',
      ...(await at(tickets['p'] as string)),
      answer: 'x',
      gist: 'two\nlines',
    });
    expect(codeOf(noGist)).toBe('FIELD_VALUE_INVALID');
    // A resolved ticket is not resolved twice.
    expect(codeOf(await resolve(owner, tickets['g'] as string))).toBe('TRANSITION_NOT_PERMITTED');
  });

  it('WF-2 out of scope closes the ticket and adds one Out of scope item linking it', async () => {
    const { map, tickets } = await charted(owner, {
      title: 'scope map',
      tickets: [{ ref: 'a', title: 'not now', type: 'task' }],
    });
    const id = tickets['a'] as string;
    expect(
      codeOf(
        await w.as(writer, {
          command: 'task.close_out_of_scope',
          ...(await at(id)),
          reason: 'later',
        }),
      ),
    ).toBe('SCOPE_NOT_GRANTED');
    must(
      await w.as(owner, { command: 'task.close_out_of_scope', ...(await at(id)), reason: 'later' }),
      'close',
    );
    const view = (await w.read(owner, { read: 'map.view', recordId: map })) as {
      map: {
        outOfScope: readonly { ticketId: string | null; text: string }[];
        tickets: readonly { id: string; state: string }[];
      };
    };
    expect(view.map.outOfScope.map((o) => o.ticketId)).toStrictEqual([id]);
    expect(await frontierRows(map)).toStrictEqual([]);
  });

  it('WF-2 each tracked action is written by its command in the same transaction and audited', async () => {
    const before = (await w.audit()).length;
    const { map, tickets } = await charted(owner, {
      title: 'audit map',
      tickets: [
        { ref: 'a', title: 'a', type: 'research' },
        { ref: 'b', title: 'b', type: 'task' },
      ],
      fog: ['p'],
    });
    const [a, b] = [tickets['a'] as string, tickets['b'] as string];
    must(await block(owner, b, [a]), 'block');
    must(await claim(owner, a), 'claim');
    must(await resolve(owner, a), 'resolve');
    const patch = (await frontierOf(owner, map)).fog[0]?.id;
    must(
      await w.as(owner, {
        command: 'map.graduate',
        ...(await at(map)),
        patchId: patch,
        tickets: [{ title: 'g', type: 'task' }],
      }),
      'graduate',
    );
    must(
      await w.as(owner, { command: 'task.close_out_of_scope', ...(await at(b)), reason: 'no' }),
      'close',
    );
    // Reads are audited too (I13); this line is about the writes.
    const lines = (await w.audit()).slice(before).filter((l) => l.command !== 'map.frontier');
    expect(lines.map((l) => [l.command, l.outcome])).toStrictEqual([
      ['map.chart', 'applied'],
      ['task.set_blocking', 'applied'],
      ['task.claim', 'applied'],
      ['task.resolve', 'applied'],
      ['map.graduate', 'applied'],
      ['task.close_out_of_scope', 'applied'],
    ]);
    // A refused resolve writes nothing: the ticket's revision stays.
    const revision = await w.revisionOf(b);
    expect(codeOf(await resolve(owner, b))).toBe('TRANSITION_NOT_PERMITTED');
    expect(await w.revisionOf(b)).toBe(revision);
  });

  it('WF-2 refuses each permission key it names to a caller without it', async () => {
    const { map, tickets } = await charted(owner, {
      title: 'keys map',
      tickets: [
        { ref: 'a', title: 'a', type: 'research' },
        { ref: 'b', title: 'b', type: 'research' },
      ],
      fog: ['p'],
    });
    const [a, b] = [tickets['a'] as string, tickets['b'] as string];
    // task:write
    expect(codeOf(await chart(reader, { title: 'x' }))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await block(reader, b, [a]))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await resolve(reader, a))).toBe('SCOPE_NOT_GRANTED');
    const patch = (await frontierOf(owner, map)).fog[0]?.id;
    expect(
      codeOf(
        await w.as(reader, {
          command: 'map.graduate',
          ...(await at(map)),
          patchId: patch,
          tickets: [{ title: 'g', type: 'task' }],
        }),
      ),
    ).toBe('SCOPE_NOT_GRANTED');
    // task:assign: the writer holds write and not assign; the assigner claims.
    expect(codeOf(await claim(writer, a))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await claim(assigner, a))).toBe('applied');
    // task:decide: out of scope.
    expect(
      codeOf(
        await w.as(writer, { command: 'task.close_out_of_scope', ...(await at(b)), reason: 'x' }),
      ),
    ).toBe('SCOPE_NOT_GRANTED');
  });

  it('WF-2 an agent is refused a grilling resolve, and a retype to route around it is refused first', async () => {
    const { tickets } = await charted(owner, {
      title: 'agent map',
      tickets: [{ ref: 'g', title: 'owner decides', type: 'grilling' }],
    });
    const picked = await w.pickUp(owner, 'agent picks this up');
    // Its own ticket, under the map, as grilling.
    const g = tickets['g'] as string;
    for (const [command, extra] of [
      ['task.set_type', { taskType: 'research' }],
      ['task.resolve', { answer: 'x', gist: 'y' }],
      ['task.claim', {}],
    ] as const) {
      const answer = await w.asAgent(
        { command, operationId: randomUUID(), ...(await at(g)), ...extra },
        picked.credential,
      );
      expect(codeOf(answer)).not.toBe('applied');
    }
    const rows = await w.db.admin.execute<{ readonly type: string; readonly gist: string | null }>(
      `select data->>'type' as type, data->>'gist' as gist from public.records where business_id = $1 and id = $2`,
      [w.business, g],
    );
    expect(rows[0]).toStrictEqual({ type: 'grilling', gist: null });
    // The ticket stays open for the map's owner.
    expect(codeOf(await resolve(owner, g))).toBe('applied');
  });

  it('WF-2 a grilling ticket cannot leave its map to route around its owner', async () => {
    const { map, tickets } = await charted(owner, {
      title: 'escape map',
      tickets: [{ ref: 'g', title: 'owner decides', type: 'grilling' }],
    });
    const g = tickets['g'] as string;
    // The teammate holds business-wide write and decide, and does not own the map.
    const out = await w.as(teammate, {
      command: 'task.reparent',
      ...(await at(g)),
      parentId: null,
    });
    expect(codeOf(out)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(out)).toContain('map owner');
    expect(codeOf(await resolve(teammate, g))).toBe('SCOPE_NOT_GRANTED');
    const rows = await w.db.admin.execute<{
      readonly parent: string;
      readonly gist: string | null;
    }>(
      `select data->>'parent' as parent, data->>'gist' as gist from public.records
        where business_id = $1 and id = $2`,
      [w.business, g],
    );
    expect(rows[0]).toStrictEqual({ parent: map, gist: null });
    // The owner may move it.
    expect(
      codeOf(await w.as(owner, { command: 'task.reparent', ...(await at(g)), parentId: null })),
    ).toBe('applied');
  });

  it('WF-2 isolation', async () => {
    const mapA = await charted(owner, {
      title: 'canary-A',
      tickets: [{ ref: 'a', title: 'A1', type: 'research' }],
    });
    const mapB = await charted(owner, {
      title: 'canary-map-B',
      tickets: [{ ref: 'b', title: 'canary-ticket-B', type: 'research' }],
      fog: ['canary-fog-B'],
    });
    for (const [map, client] of [
      [mapA.map, randomUUID()],
      [mapB.map, randomUUID()],
    ] as const) {
      must(await w.as(owner, { command: 'map.scope', ...(await at(map)), client }), 'scope');
    }
    const onA = await w.member('on-a2', ['read', 'write', 'assign', 'decide'], {
      kind: 'record',
      id: mapA.map,
    });
    const bea = await w.outsider('bea2');
    const ticketB = mapB.tickets['b'] as string;
    const foreign = [mapB.map, ticketB, 'canary-map-B', 'canary-ticket-B', 'canary-fog-B'];
    const clean = (answer: unknown) => {
      const text = JSON.stringify(answer);
      for (const canary of foreign) expect(text).not.toContain(canary);
    };

    // 1. Another business.
    for (const answer of [
      await w.read(bea, { read: 'map.frontier', recordId: mapB.map }, w.bravo),
      await w.as(bea, { command: 'task.claim', recordId: ticketB, expectedRevision: 1 }, w.bravo),
      await w.as(
        bea,
        { command: 'task.resolve', recordId: ticketB, expectedRevision: 1, answer: 'x', gist: 'y' },
        w.bravo,
      ),
    ]) {
      expect(codeOf(answer)).toBe('NOT_FOUND');
      clean(answer);
    }
    // 2. Another client's map in the same business.
    expect((await frontierOf(onA, mapA.map)).frontier).toHaveLength(1);
    expect(codeOf(await claim(onA, mapA.tickets['a'] as string))).toBe('applied');
    for (const answer of [
      await w.read(onA, { read: 'map.frontier', recordId: mapB.map }),
      await claim(onA, ticketB),
      await resolve(onA, ticketB),
      await block(onA, ticketB, []),
      await w.as(onA, {
        command: 'map.graduate',
        ...(await at(mapB.map)),
        patchId: randomUUID(),
        tickets: [],
      }),
    ]) {
      expect(codeOf(answer)).toBe('SCOPE_NOT_GRANTED');
      clean(answer);
    }
    // A blocker from another client's map is not named as found.
    const blocked = await block(onA, mapA.tickets['a'] as string, [ticketB]);
    expect(codeOf(blocked)).toBe('NOT_FOUND');
    clean(blocked);
    // 3. An agent under a live delegation reaches none of map B.
    const picked = await w.pickUp(owner, 'delegated work two');
    for (const [command, extra] of [
      ['task.claim', {}],
      ['task.resolve', { answer: 'x', gist: 'y' }],
    ] as const) {
      const answer = await w.asAgent(
        { command, operationId: randomUUID(), ...(await at(ticketB)), ...extra },
        picked.credential,
      );
      expect(codeOf(answer)).not.toBe('applied');
      clean(answer);
    }
    expect((await frontierOf(owner, mapB.map)).frontier.map((t) => t.id)).toStrictEqual([ticketB]);
  });
});
