// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// API-4's *work this ticket* (#632): the refusal per key and `API-4 isolation`
// for the bundle, through the verb CLI over the composed API. The three real
// crossings (another business, another client's map in the same business, an
// agent under a live delegation), statuses checked, canaries absent.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type Caller, type CliWorld } from './api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('API-4 work this ticket, isolation', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;

  beforeAll(async () => {
    w = await cliWorld('api4ctxiso', 'api4ctxiso');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  /** A charted map: a blocks b. */
  async function chartedMap(title: string) {
    const answer = await w.as(lead, {
      command: 'map.chart',
      title,
      destination: `${title}: the import reports every skipped row`,
      tickets: [
        { ref: 'a', title: `${title} find the rules`, type: 'research' },
        { ref: 'b', title: `${title} choose the flow`, type: 'task', blockedBy: ['a'] },
      ],
      fog: [],
    });
    const map = must(answer, 'map.chart').id;
    const tickets = (answer as { detail?: { tickets?: Record<string, string> } }).detail
      ?.tickets as Record<string, string>;
    // The lead reads it: the bundle is there to be withheld.
    expect((await cli.run('task', 'context', tickets['b'] as string)).exit).toBe(0);
    return { map, tickets };
  }

  it('API-4 a blocks link from a record that is not a task is never shown, in the bundle or the task read', async () => {
    const { tickets } = await chartedMap('foreign-type ctx');
    const b = tickets['b'] as string;
    // The ticket's own state record, linked as a blocker behind the commands' back.
    const [row] = await w.db.admin.execute<{ readonly state: string }>(
      `select uuid_1::text as state from public.records where business_id = $1 and id = $2`,
      [w.business, b],
    );
    const state = row?.state as string;
    await w.db.admin.execute(
      `insert into public.record_links (business_id, id, link_type, from_record_id, to_record_id)
       values ($1, $2, 'blocks', $3, $4)`,
      [w.business, randomUUID(), state, b],
    );
    const answer = await cli.run('task', 'context', b, '--detail', 'full', '--json');
    expect(answer.exit, answer.out).toBe(0);
    const got = JSON.parse(answer.out) as { blockedBy: readonly { id: string }[] };
    expect(got.blockedBy.map((one) => one.id)).toStrictEqual([tickets['a']]);
    expect(answer.out).not.toContain(`"id":"${state}","key"`);
    // API-3's leveled task read lists the same blockers.
    const read = await cli.run('task', 'get', b, '--detail', 'full', '--json');
    expect(read.exit, read.out).toBe(0);
    expect((JSON.parse(read.out) as { blockedBy: readonly string[] }).blockedBy).toStrictEqual([
      tickets['a'],
    ]);
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
