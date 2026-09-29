// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, no-await-in-loop -- one suite over one world; the scripted run works one ticket at a time */
//
// API-4's checklist lines for *work this ticket* (#632), through the verb CLI
// over the composed API: the ticket, its map's Destination and Decisions so
// far, what blocks it and what it blocks, its acceptance checks, its linked
// documents and its recent thread, in one call and one statement, current in
// the writing transaction. A part the caller may not read is left out and
// named as withheld. *Changes since* is held (LEANS-ON SL10 U26, the slice
// handback).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTicketContext } from '../../packages/core-commands/src/reads/ticket-context.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, revisionIn, type Caller, type CliWorld } from './api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Json = Readonly<Record<string, unknown>>;

interface Context {
  readonly ticket: Json;
  readonly map?: Json & { readonly decisions: readonly Json[] };
  readonly blockedBy: readonly Json[];
  readonly blocks: readonly Json[];
  readonly acceptance: readonly string[];
  readonly documents: readonly Json[];
  readonly thread: readonly Json[];
  readonly threadCount: number;
  readonly withheld?: Readonly<Record<string, number>>;
}

const CHECKS = ['- [ ] the report lists each skipped row', '- [x] the run keeps going'];
const DESCRIPTION = [
  'Choose how the import reports what it skips.',
  '',
  'Acceptance:',
  ...CHECKS,
].join('\n');

describe.skipIf(serverUrl === undefined)('API-4 work this ticket', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;

  beforeAll(async () => {
    w = await cliWorld('api4ctx', 'api4ctx');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  async function comment(id: string, body: string) {
    must(
      await w.as(lead, {
        command: 'task.comment',
        recordId: id,
        expectedRevision: await w.revisionOf(id),
        audience: 'internal',
        body,
      }),
      'comment',
    );
  }

  async function resolve(id: string, gist: string) {
    must(
      await w.as(lead, {
        command: 'task.resolve',
        recordId: id,
        expectedRevision: await w.revisionOf(id),
        answer: `${gist}, in full`,
        gist,
      }),
      'resolve',
    );
  }

  /**
   * A charted map: a (research) blocks b (task), b blocks c (build); d
   * (grilling) is resolved, so Decisions so far has one line. b carries the
   * acceptance checks in its description and a thread of six comments.
   */
  async function chartedMap(title = 'context map') {
    const answer = await w.as(lead, {
      command: 'map.chart',
      title,
      destination: `${title}: the import reports every skipped row`,
      tickets: [
        { ref: 'a', title: `${title} find the rules`, type: 'research' },
        { ref: 'b', title: `${title} choose the flow`, type: 'task', blockedBy: ['a'] },
        { ref: 'c', title: `${title} draft the report`, type: 'build', blockedBy: ['b'] },
        { ref: 'd', title: `${title} settle the format`, type: 'grilling' },
      ],
      fog: [`${title} unknown one`],
    });
    const map = must(answer, 'map.chart').id;
    const tickets = (answer as { detail?: { tickets?: Record<string, string> } }).detail
      ?.tickets as Record<string, string>;
    const b = tickets['b'] as string;
    must(
      await w.as(lead, {
        command: 'task.update',
        recordId: b,
        expectedRevision: await w.revisionOf(b),
        fields: { description: DESCRIPTION },
      }),
      'describe',
    );
    for (let at = 1; at <= 6; at += 1) await comment(b, `${title} note ${String(at)}`);
    await resolve(tickets['d'] as string, `${title} format is one line per row`);
    return { map, tickets };
  }

  async function context(caller: Caller, id: string, detail = 'standard'): Promise<Context> {
    const answer = await caller.run('task', 'context', id, '--detail', detail, '--json');
    expect(answer.exit, answer.out).toBe(0);
    return JSON.parse(answer.out) as Context;
  }

  it('API-4 work this ticket returns the ticket, its map’s Destination and Decisions so far, its blockers and what it blocks, its acceptance checks, linked documents by title and link and the recent thread, in one call', async () => {
    const { tickets } = await chartedMap();
    const before = cli.requests();
    const got = await context(cli, tickets['b'] as string);
    expect(cli.requests() - before).toBe(1);
    expect(got.ticket['title']).toBe('context map choose the flow');
    expect(got.ticket['type']).toBe('task');
    expect(got.ticket['description']).toBe(DESCRIPTION);
    expect(got.map?.['title']).toBe('context map');
    expect(got.map?.['destination']).toBe('context map: the import reports every skipped row');
    expect(got.map?.decisions.map((line) => line['gist'])).toStrictEqual([
      'context map format is one line per row',
    ]);
    expect(got.blockedBy.map((one) => one['title'])).toStrictEqual(['context map find the rules']);
    expect(got.blocks.map((one) => one['title'])).toStrictEqual(['context map draft the report']);
    expect(got.acceptance).toStrictEqual(CHECKS);
    // Documents are linked by title and link once WF-8 gives them a home (TR-A2-7).
    expect(got.documents).toStrictEqual([]);
    // The recent thread: the latest five of six, oldest first, and how many there are.
    expect(got.thread.map((one) => one['body'])).toStrictEqual(
      [2, 3, 4, 5, 6].map((at) => `context map note ${String(at)}`),
    );
    expect(got.threadCount).toBe(6);
    expect(got.withheld).toBeUndefined();
  });

  it('API-4 work this ticket is one query on its read model', async () => {
    const { tickets } = await chartedMap('one query ctx');
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
      return await readTicketContext(counted, spine, tickets['b'] as string);
    });
    expect(answer?.blockedBy).toHaveLength(1);
    expect(answer?.thread).toHaveLength(6);
    expect(statements).toBe(1);
  });

  it('API-4 work this ticket: a read after a write never shows the old state', async () => {
    const { tickets } = await chartedMap('fresh ctx');
    const a = tickets['a'] as string;
    const b = tickets['b'] as string;
    const stale = await context(cli, b);
    expect(stale.blockedBy[0]?.['category']).not.toBe('completed');
    await resolve(a, 'fresh ctx rules found');
    await comment(b, 'fresh ctx note 7');
    const got = await context(cli, b);
    expect(got.map?.decisions.map((line) => line['gist'])).toStrictEqual([
      'fresh ctx format is one line per row',
      'fresh ctx rules found',
    ]);
    expect(got.blockedBy[0]?.['category']).toBe('completed');
    expect(got.thread.at(-1)?.['body']).toBe('fresh ctx note 7');
    expect(got.threadCount).toBe(7);
  });

  it('API-4 work this ticket takes brief, standard and full', async () => {
    const { tickets } = await chartedMap('levels ctx');
    const b = tickets['b'] as string;
    const brief = await context(cli, b, 'brief');
    const standard = await context(cli, b, 'standard');
    const full = await context(cli, b, 'full');
    // Full carries every id and the whole thread.
    expect(full.ticket['id']).toBe(b);
    expect(full.blockedBy[0]?.['id']).toBe(tickets['a']);
    expect(full.thread).toHaveLength(6);
    // Standard names things by key and title, and carries the latest five comments.
    expect(standard.ticket['id']).toBeUndefined();
    expect(standard.blockedBy[0]?.['key']).toBeTypeOf('string');
    expect(standard.thread).toHaveLength(5);
    // Brief: names and state, no description and no thread bodies.
    expect(brief.ticket['description']).toBeUndefined();
    expect(brief.thread).toStrictEqual([]);
    expect(brief.threadCount).toBe(6);
    expect(Object.keys(brief.blockedBy[0] ?? {})).toStrictEqual(['key']);
  });

  it('API-4 a part the caller may not read is left out and named as withheld, never silently dropped', async () => {
    const { map, tickets } = await chartedMap('canary-withheld');
    const b = tickets['b'] as string;
    // Read on ticket b alone: not on its map, not on the tickets around it.
    const narrow = await w.person(await w.member('b-only', ['read'], { kind: 'record', id: b }));
    const answer = await narrow.run('task', 'context', b, '--detail', 'full', '--json');
    expect(answer.exit, answer.out).toBe(0);
    const got = JSON.parse(answer.out) as Context;
    expect(got.ticket['id']).toBe(b);
    expect(got.map).toBeUndefined();
    expect(got.blockedBy).toStrictEqual([]);
    expect(got.blocks).toStrictEqual([]);
    expect(got.withheld).toStrictEqual({ map: 1, blockedBy: 1, blocks: 1 });
    for (const canary of [
      map,
      tickets['a'],
      tickets['c'],
      tickets['d'],
      'canary-withheld find the rules',
      'canary-withheld draft the report',
      'canary-withheld: the import',
      'canary-withheld format is one line',
    ]) {
      expect(answer.out).not.toContain(canary);
    }
  });

  it('API-4 completeness: a scripted agent works one fixture ticket of each type from its bundle alone with zero follow-up reads', async () => {
    const types = ['research', 'task', 'build', 'grilling', 'prototype'] as const;
    const charted = await w.as(lead, {
      command: 'map.chart',
      title: 'scripted map',
      destination: 'every ticket worked from its bundle',
      tickets: types.map((type) => ({ ref: type, title: `scripted ${type}`, type })),
      fog: [],
    });
    const map = must(charted, 'map.chart').id;
    const ids = (charted as { detail?: { tickets?: Record<string, string> } }).detail
      ?.tickets as Record<string, string>;
    for (const type of types) {
      const id = ids[type] as string;
      const before = (await w.audit()).length;
      // The script: one bundle, then the work, every value taken from the bundle.
      const bundle = await context(cli, id);
      expect(bundle.ticket['type']).toBe(type);
      expect(bundle.map?.['destination']).toBe('every ticket worked from its bundle');
      const noted = await cli.run(
        'task',
        'comment',
        String(bundle.ticket['key']),
        '--revision',
        String(bundle.ticket['revision']),
        '--text',
        `worked toward: ${String(bundle.map?.['destination'])}`,
      );
      expect(noted.exit, noted.out).toBe(0);
      const done = await cli.run(
        'task',
        'resolve',
        String(bundle.ticket['key']),
        '--revision',
        revisionIn(noted),
        '--answer',
        `${type} done`,
        '--gist',
        `${type} done`,
      );
      expect(done.exit, done.out).toBe(0);
      // The read log: exactly one read for the ticket, the bundle.
      const events = (await w.audit()).slice(before);
      const reads = events.filter(
        (event) => !['task.comment', 'task.resolve'].includes(event.command),
      );
      expect(reads.map((event) => [event.command, event.outcome])).toStrictEqual([
        ['task.context', 'applied'],
      ]);
    }
    // The map shows the result.
    const status = await cli.run('map', 'status', map, '--json');
    expect(status.exit, status.out).toBe(0);
    const shown = JSON.parse(status.out) as { open: number; closed: number };
    expect([shown.open, shown.closed]).toStrictEqual([0, types.length]);
  });

  it('API-4 a refusal per key: work this ticket asks task:read', async () => {
    const { tickets } = await chartedMap('refused ctx');
    const stranger = await w.person(await w.member('ctx-stranger', ['comment']));
    const refused = await stranger.run('task', 'context', tickets['b'] as string);
    expect(refused.exit).toBe(1);
    expect(refused.out).toContain('task:read');
    expect(refused.out).not.toContain('refused ctx');
  });

  it('API-4 isolation: work this ticket', async () => {
    const mapA = (await chartedMap('canary-ctx-A')).map;
    const { map: mapB, tickets: onB } = await chartedMap('canary-ctx-B');
    must(
      await w.as(lead, {
        command: 'map.scope',
        recordId: mapB,
        expectedRevision: await w.revisionOf(mapB),
        client: randomUUID(),
      }),
      'scope',
    );
    const b = onB['b'] as string;
    const clean = (what: string, out: string) => {
      for (const canary of ['canary-ctx-B', mapB, b]) expect(out, what).not.toContain(canary);
    };

    // 1. Another business: bravo's person on bravo's key reaches nothing of alpha's.
    const bea = await w.person(await w.outsider('ctx-bea'), `${w.key}-bravo`);
    const crossed = await bea.run('task', 'context', b);
    expect(crossed.exit).toBe(1);
    expect(crossed.out).toContain('NOT_FOUND');
    clean('bravo', crossed.out);

    // 2. Another client in the same business: a person granted only map A.
    const scoped = await w.member('ctx-scoped-a', ['read'], { kind: 'record', id: mapA });
    const scopedCli = await w.person(scoped);
    const other = await scopedCli.run('task', 'context', b);
    expect(other.exit).toBe(1);
    expect(other.out).toContain('SCOPE_NOT_GRANTED');
    clean('other client', other.out);

    // 3. A person under a live delegation: the agent reaches no bundle
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('ctx-delegator'), 'context agent task');
    const agent = await w.agent(picked.credential);
    const delegated = await agent.run('task', 'context', b);
    expect(delegated.exit).toBe(1);
    clean('delegated', delegated.out);
  });
});
