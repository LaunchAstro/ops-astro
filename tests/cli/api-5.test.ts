// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// API-5 (#633): one CLI test per tracker operation the agent CLI adds, through
// the verb CLI over the composed API, each read back from the map as the app
// reads it; the owner check's flow; and the write budget.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { countTokens } from '../support/token-count.ts';
import { cliWorld, idOf, type Caller, type CliWorld } from './api-3-world.ts';
import { madeIds } from './api-5-tracker.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Json = Readonly<Record<string, unknown>>;
interface View {
  readonly revision: number;
  readonly destination: Json | null;
  readonly notes: Json | null;
  readonly fog: readonly Json[];
  readonly outOfScope: readonly Json[];
  readonly decisions: readonly Json[];
  readonly version: number;
  readonly tickets: readonly {
    id: string;
    title: string;
    type: string;
    state: string;
    blockedBy: string[];
  }[];
}

describe.skipIf(serverUrl === undefined)('API-5 tracker operations', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;
  const writes: string[] = [];

  beforeAll(async () => {
    w = await cliWorld('api5', 'api5');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  async function ok(...argv: string[]): Promise<string> {
    const answer = await cli.run(...argv);
    expect(answer.exit, answer.out).toBe(0);
    writes.push(answer.out);
    return answer.out;
  }
  async function view(map: string): Promise<View> {
    const answer = await cli.run('map', 'view', map, '--json');
    expect(answer.exit, answer.out).toBe(0);
    return JSON.parse(answer.out) as View;
  }
  const rev = async (id: string): Promise<string> => String(await w.revisionOf(id));

  async function chart(title: string) {
    const out = await ok(
      'map',
      'chart',
      '--title',
      title,
      '--destination',
      `${title}: the import reports every skipped row`,
      '--notes',
      'consult the import spec',
      '--fog',
      JSON.stringify([`${title} fog one`, `${title} fog two`]),
      '--tickets',
      JSON.stringify([
        { ref: 'a', title: `${title} find the rules`, type: 'research' },
        { ref: 'b', title: `${title} choose the flow`, type: 'grilling', blockedBy: ['a'] },
        { ref: 'c', title: `${title} draft the report`, type: 'task' },
      ]),
    );
    return { map: idOf({ exit: 0, out }), ids: madeIds(out) };
  }

  it('API-5 map chart: one call charts the map with its Destination, Notes, fog, typed tickets and blocking', async () => {
    const { map, ids } = await chart('charted');
    expect(Object.keys(ids).toSorted()).toStrictEqual(['a', 'b', 'c']);
    const got = await view(map);
    expect(got.destination?.['text']).toBe('charted: the import reports every skipped row');
    expect(got.notes?.['text']).toBe('consult the import spec');
    expect(got.fog.map((one) => one['text'])).toStrictEqual(['charted fog one', 'charted fog two']);
    expect(got.tickets.map((t) => [t.id, t.type, t.blockedBy])).toStrictEqual([
      [ids['a'], 'research', []],
      [ids['b'], 'grilling', [ids['a']]],
      [ids['c'], 'task', []],
    ]);
  });

  it('API-5 task create files a typed child ticket under the map', async () => {
    const { map } = await chart('child');
    const out = await ok(
      'task',
      'create',
      '--parent',
      map,
      '--type',
      'prototype',
      '--title',
      'child sketch',
    );
    const got = await view(map);
    expect(got.tickets.find((t) => t.id === idOf({ exit: 0, out }))?.type).toBe('prototype');
  });

  it('API-5 task type sets a ticket type, the wayfinder label', async () => {
    const { map, ids } = await chart('typed');
    const c = ids['c'] as string;
    await ok('task', 'type', c, '--revision', await rev(c), '--type', 'research');
    expect((await view(map)).tickets.find((t) => t.id === c)?.type).toBe('research');
  });

  it('API-5 task claim: first come; a second claim is refused and the frontier drops the ticket', async () => {
    const { map, ids } = await chart('claimed');
    const a = ids['a'] as string;
    const before = await rev(a);
    await ok('task', 'claim', a, '--revision', before);
    const again = await cli.run('task', 'claim', a, '--revision', before);
    expect(again.exit).toBe(1);
    expect(again.out).toContain('VERSION_STALE');
    const frontier = await cli.run('map', 'frontier', map, '--json');
    const listed = (JSON.parse(frontier.out) as { frontier: Json[] }).frontier;
    expect(listed.map((one) => one['id'])).toStrictEqual([ids['c']]);
  });

  it('API-5 task resolve: the answer on the thread, the ticket closed and its gist in Decisions so far, one call', async () => {
    const { map, ids } = await chart('resolved');
    const a = ids['a'] as string;
    await ok(
      'task',
      'resolve',
      a,
      '--revision',
      await rev(a),
      '--answer',
      'rules in the spec',
      '--gist',
      'rules found',
    );
    const got = await view(map);
    expect(got.decisions.map((one) => [one['ticketId'], one['gist']])).toStrictEqual([
      [a, 'rules found'],
    ]);
    expect(got.tickets.find((t) => t.id === a)?.state).not.toBe(
      got.tickets.find((t) => t.id === ids['c'])?.state,
    );
  });

  it('API-5 map graduate turns a fog patch into tickets and prints their ids', async () => {
    const { map } = await chart('graduated');
    const before = await view(map);
    const patch = before.fog[0]?.['id'] as string;
    const out = await ok(
      'map',
      'graduate',
      map,
      '--revision',
      String(before.revision),
      '--patch',
      patch,
      '--tickets',
      JSON.stringify([{ title: 'graduated new question', type: 'grilling' }]),
    );
    const made = Object.values(madeIds(out));
    expect(made).toHaveLength(1);
    const after = await view(map);
    expect(after.fog.map((one) => one['text'])).toStrictEqual(['graduated fog two']);
    expect(after.tickets.find((t) => t.id === made[0])?.title).toBe('graduated new question');
  });

  it('API-5 task out-of-scope closes a ticket with one Out of scope item', async () => {
    const { map, ids } = await chart('scoped out');
    const c = ids['c'] as string;
    await ok(
      'task',
      'out-of-scope',
      c,
      '--revision',
      await rev(c),
      '--reason',
      'past the destination',
    );
    const got = await view(map);
    expect(got.outOfScope.map((one) => one['ticketId'])).toStrictEqual([c]);
    expect(got.decisions).toHaveLength(0);
  });

  it('API-5 map revise edits Destination, Notes and fog as a numbered version', async () => {
    const { map } = await chart('revised');
    const before = await view(map);
    await ok(
      'map',
      'revise',
      map,
      '--revision',
      String(before.revision),
      '--notes',
      'notes, revised',
      '--add-fog',
      JSON.stringify(['revised fog three']),
      '--retire',
      before.fog[0]?.['id'] as string,
    );
    const after = await view(map);
    expect(after.version).toBe(before.version + 1);
    expect(after.notes?.['text']).toBe('notes, revised');
    expect(after.fog.map((one) => one['text'])).toStrictEqual([
      'revised fog two',
      'revised fog three',
    ]);
  });

  it('API-5 task close closes an issue', async () => {
    const out = await ok('task', 'create', '--title', 'plain issue');
    const id = idOf({ exit: 0, out });
    await ok('task', 'close', id, '--revision', await rev(id));
    const read = await cli.run('task', 'get', id, '--detail', 'brief', '--json');
    expect(read.out).toMatch(/"state":"(done|completed|closed)"/u);
  });

  it('API-5 owner check flow: chart a small map with three tickets through the tracker operations; the app shows the map, tickets, blocking and fog exactly as charted', async () => {
    const mapOut = await ok(
      'map',
      'chart',
      '--title',
      'owner check map',
      '--destination',
      'a clear import plan',
      '--notes',
      'import work',
      '--fog',
      JSON.stringify(['how refunds import']),
    );
    const map = idOf({ exit: 0, out: mapOut });
    const file = async (title: string, type: string) =>
      idOf({
        exit: 0,
        out: await ok('task', 'create', '--parent', map, '--type', type, '--title', title),
      });
    const one = await file('which columns matter', 'research');
    const two = await file('agree the mapping', 'grilling');
    const three = await file('get a sample export', 'task');
    await ok('task', 'link', two, '--revision', await rev(two), '--blocked-by', `${one},${three}`);
    // The app's read of the map, as the map view draws it.
    const app = (await w.read(lead, { command: 'map.view', recordId: map })) as { map: View };
    expect(app.map.destination?.['text']).toBe('a clear import plan');
    expect(app.map.fog.map((f) => f['text'])).toStrictEqual(['how refunds import']);
    expect(app.map.tickets.map((t) => [t.title, t.type, t.blockedBy.toSorted()])).toStrictEqual([
      ['which columns matter', 'research', []],
      ['agree the mapping', 'grilling', [one, three].toSorted()],
      ['get a sample export', 'task', []],
    ]);
  });

  it("API-5 budget: every tracker write's default result is under 150 tokens", () => {
    expect(writes.length).toBeGreaterThan(10);
    const largest = Math.max(...writes.map((out) => countTokens(out)));
    expect(largest).toBeLessThan(150);
  });
});
