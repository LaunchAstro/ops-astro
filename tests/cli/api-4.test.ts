// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// API-4's checklist lines for *map status* (#632), through the verb CLI over
// the composed API: the frontier, the fog and the counts in one call, served
// by one query on the map's read models, current in the writing transaction.
// *Work this ticket* and *changes since* are held (see the slice handback).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMapStatus } from '../../packages/core-commands/src/reads/maps.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type Caller, type CliWorld } from './api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Json = Readonly<Record<string, unknown>>;

interface Status {
  readonly map: string;
  readonly version: number;
  readonly open: number;
  readonly closed: number;
  readonly outOfScope: number;
  readonly frontier: readonly Json[];
  readonly fog: readonly Json[];
}

describe.skipIf(serverUrl === undefined)('API-4 map status', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;

  beforeAll(async () => {
    w = await cliWorld('api4', 'api4');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  /** A charted map: a, then b blocked by a, and c; two fog lines. */
  async function chartedMap(title = 'status map') {
    const answer = await w.as(lead, {
      command: 'map.chart',
      title,
      destination: 'the import reports every skipped row',
      tickets: [
        { ref: 'a', title: `${title} find the rules`, type: 'research' },
        { ref: 'b', title: `${title} choose the flow`, type: 'task', blockedBy: ['a'] },
        { ref: 'c', title: `${title} draft the report`, type: 'build' },
      ],
      fog: [`${title} unknown one`, `${title} unknown two`],
    });
    const made = must(answer, 'map.chart');
    const tickets = (answer as { detail?: { tickets?: Record<string, string> } }).detail?.tickets;
    return { map: made.id, tickets: tickets ?? {} };
  }

  async function status(caller: Caller, map: string, detail = 'full'): Promise<Status> {
    const answer = await caller.run('map', 'status', map, '--detail', detail, '--json');
    expect(answer.exit, answer.out).toBe(0);
    return JSON.parse(answer.out) as Status;
  }

  it('API-4 map status returns the frontier, the fog and the counts, in one call', async () => {
    const { map, tickets } = await chartedMap();
    const before = cli.requests();
    const got = await status(cli, map);
    expect(cli.requests() - before).toBe(1);
    expect(got.map).toBe(map);
    expect(got.frontier.map((ticket) => ticket['id'])).toStrictEqual([tickets['a'], tickets['c']]);
    expect(got.fog.map((line) => line['text'])).toStrictEqual([
      'status map unknown one',
      'status map unknown two',
    ]);
    expect([got.open, got.closed, got.outOfScope]).toStrictEqual([3, 0, 0]);
  });

  it('API-4 map status is one query on its read models', async () => {
    const { map } = await chartedMap('one query map');
    let statements = 0;
    const answer = await w.db.app.withBusiness(w.business, async (tx) => {
      const spine = await readTaskSpine(tx);
      const counted: TenantQuery = {
        ...tx,
        businessId: tx.businessId,
        query: async (text, values) => {
          statements += 1;
          return await tx.query(text, values);
        },
      };
      return await readMapStatus(counted, spine.taskTypeId, map, 'full');
    });
    expect(answer?.frontier).toHaveLength(2);
    expect(statements).toBe(1);
  });

  it('API-4 the read models are updated in the same transaction as the write: a read after a write never shows the old state', async () => {
    const { map, tickets } = await chartedMap('fresh map');
    const a = tickets['a'] as string;
    must(
      await w.as(lead, {
        command: 'task.resolve',
        recordId: a,
        expectedRevision: await w.revisionOf(a),
        answer: 'the rules are in the import spec',
        gist: 'rules found',
      }),
      'resolve',
    );
    const got = await status(cli, map);
    expect(got.frontier.map((ticket) => ticket['id'])).toStrictEqual([tickets['b'], tickets['c']]);
    expect([got.open, got.closed]).toStrictEqual([2, 1]);
  });

  it('API-4 map status takes brief, standard and full', async () => {
    const { map, tickets } = await chartedMap('levels map');
    const brief = await status(cli, map, 'brief');
    const standard = await status(cli, map, 'standard');
    const full = await status(cli, map, 'full');
    // Full carries ids; standard names each frontier ticket by key, title and type.
    expect(full.frontier[0]?.['id']).toBe(tickets['a']);
    expect(Object.keys(standard.frontier[0] ?? {}).toSorted()).toStrictEqual([
      'key',
      'title',
      'type',
    ]);
    // Brief keeps the counts and names the frontier by key only.
    expect(Object.keys(brief.frontier[0] ?? {})).toStrictEqual(['key']);
    expect(brief.open).toBe(3);
  });

  it('API-4 isolation', async () => {
    const mapA = (await chartedMap('canary-status-A')).map;
    const mapB = (await chartedMap('canary-status-B')).map;
    must(
      await w.as(lead, {
        command: 'map.scope',
        recordId: mapB,
        expectedRevision: await w.revisionOf(mapB),
        client: randomUUID(),
      }),
      'scope',
    );
    const clean = (what: string, out: string) => {
      for (const canary of ['canary-status-B', mapB]) expect(out, what).not.toContain(canary);
    };

    // 1. Another business: bravo's person on bravo's key reaches nothing of alpha's.
    const bea = await w.person(await w.outsider('bea'), `${w.key}-bravo`);
    const crossed = await bea.run('map', 'status', mapB);
    expect(crossed.exit).toBe(1);
    expect(crossed.out).toContain('NOT_FOUND');
    clean('bravo', crossed.out);

    // 2. Another client in the same business: a person granted only map A.
    const scoped = await w.member('scoped-a', ['read'], { kind: 'record', id: mapA });
    const scopedCli = await w.person(scoped);
    expect((await scopedCli.run('map', 'status', mapA)).exit).toBe(0);
    const other = await scopedCli.run('map', 'status', mapB);
    expect(other.exit).toBe(1);
    expect(other.out).toContain('SCOPE_NOT_GRANTED');
    clean('other client', other.out);

    // 3. A person under a live delegation: the agent reaches no map status
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('status-delegator'), 'status agent task');
    const agent = await w.agent(picked.credential);
    const delegated = await agent.run('map', 'status', mapB);
    expect(delegated.exit).toBe(1);
    clean('delegated', delegated.out);
  });
});
