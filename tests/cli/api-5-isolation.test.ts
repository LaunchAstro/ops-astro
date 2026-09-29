// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- calls in order; the three crossings over one world */
//
// `API-5 isolation` (#633, standing gate 9): through the tracker operations,
// another business's maps and tickets, and another client's in the same
// business, are never read, listed, counted or changed; an agent under a live
// delegation reaches none of them. Every crossing's status is checked, and the
// stored canaries (ids, titles, fog text) appear in no answer, refusals included.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, idOf, type Caller, type CliWorld } from './api-3-world.ts';
import { madeIds } from './api-5-tracker.ts';
import { must } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Every tracker operation against one map and its ticket, as a caller would send it. */
const operations = (m: { map: string; a: string; b: string; patch: string }): string[][] => [
  ['map', 'view', m.map],
  ['map', 'frontier', m.map],
  ['map', 'status', m.map],
  ['task', 'get', m.a],
  ['task', 'context', m.a],
  ['task', 'create', '--parent', m.map, '--type', 'task', '--title', 'crossing'],
  ['task', 'type', m.a, '--revision', '1', '--type', 'research'],
  ['task', 'link', m.b, '--revision', '1', '--blocked-by', m.a],
  ['task', 'claim', m.a, '--revision', '1'],
  ['task', 'resolve', m.a, '--revision', '1', '--answer', 'x', '--gist', 'x'],
  ['task', 'out-of-scope', m.a, '--revision', '1', '--reason', 'x'],
  ['task', 'close', m.a, '--revision', '1'],
  ['map', 'revise', m.map, '--revision', '1', '--notes', 'x'],
  [
    'map',
    'graduate',
    m.map,
    '--revision',
    '1',
    '--patch',
    m.patch,
    '--tickets',
    '[{"title":"x","type":"task"}]',
  ],
];

describe.skipIf(serverUrl === undefined)('API-5 isolation', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;

  beforeAll(async () => {
    w = await cliWorld('api5iso', 'api5iso');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  async function chart(title: string) {
    const answer = await cli.run(
      'map',
      'chart',
      '--title',
      title,
      '--fog',
      JSON.stringify([`${title} fog`]),
      '--tickets',
      JSON.stringify([
        { ref: 'a', title: `${title} ticket a`, type: 'task' },
        { ref: 'b', title: `${title} ticket b`, type: 'task' },
      ]),
    );
    expect(answer.exit, answer.out).toBe(0);
    const ids = madeIds(answer.out) as { a: string; b: string };
    const patch = await w.db.admin.execute<{ readonly id: string }>(
      `select id::text from public.map_components where map_id = $1 and kind = 'fog'`,
      [idOf(answer)],
    );
    return { map: idOf(answer), ...ids, patch: patch[0]?.id as string };
  }

  it('API-5 isolation', async () => {
    const mapA = await chart('canary-tracker-A');
    const mapB = await chart('canary-tracker-B');
    must(
      await w.as(lead, {
        command: 'map.scope',
        recordId: mapB.map,
        expectedRevision: await w.revisionOf(mapB.map),
        client: randomUUID(),
      }),
      'scope',
    );
    const canaries = ['canary-tracker-B', mapB.map, mapB.a, mapB.b, mapB.patch];
    const revisions = async () =>
      await Promise.all([mapB.map, mapB.a, mapB.b].map(async (id) => await w.revisionOf(id)));
    const before = await revisions();

    async function crossing(caller: Caller, code: RegExp, what: string): Promise<void> {
      for (const argv of operations(mapB)) {
        const answer = await caller.run(...argv);
        expect(answer.exit, `${what}: ${argv.join(' ')}`).toBe(1);
        expect(answer.out, `${what}: ${argv.join(' ')}`).toMatch(code);
        for (const canary of canaries)
          expect(answer.out, `${what}: ${argv.join(' ')}`).not.toContain(canary);
      }
    }

    // 1. Another business: bravo's person on bravo's key reaches nothing of
    // alpha's, and learns nothing: each answer is word for word the answer for
    // ids that exist nowhere (NOT_FOUND, or the key bravo's own grant lacks).
    const bea = await w.person(await w.outsider('bea'), `${w.key}-bravo`);
    await crossing(bea, /NOT_FOUND|SCOPE_NOT_GRANTED/u, 'bravo');
    const nowhere = { map: randomUUID(), a: randomUUID(), b: randomUUID(), patch: randomUUID() };
    const real = operations(mapB);
    const none = operations(nowhere);
    for (const [at, argv] of real.entries()) {
      const one = (await bea.run(...argv)).out;
      const other = (await bea.run(...(none[at] as string[]))).out;
      expect(one, argv.join(' ')).toBe(other);
    }
    // Bravo's own list and count show none of alpha's.
    const listed = await bea.run('task', 'list', '--detail', 'brief', '--json');
    for (const canary of canaries) expect(listed.out).not.toContain(canary);

    // 2. Another client in the same business: a person holding every key on map A only.
    const scoped = await w.member('scoped-a', ['read', 'write', 'assign', 'decide'], {
      kind: 'record',
      id: mapA.map,
    });
    const scopedCli = await w.person(scoped);
    expect((await scopedCli.run('map', 'frontier', mapA.map)).exit).toBe(0);
    await crossing(scopedCli, /SCOPE_NOT_GRANTED|NOT_FOUND/u, 'other client');

    // 3. A person under a live delegation: the agent reaches no tracker operation
    // on the map (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('tracker-delegator'), 'tracker agent task');
    const agent = await w.agent(picked.credential);
    await crossing(agent, /refused [A-Z_]+/u, 'delegated');

    // Nothing of map B moved.
    expect(await revisions()).toStrictEqual(before);
  });
});
