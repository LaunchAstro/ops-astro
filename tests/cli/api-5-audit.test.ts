// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- calls in order; one suite over one world */
//
// API-5 (#633): every change a tracker operation makes is recorded by the
// owning command in the writing transaction and joins the audit chain, read
// back; and a refusal per permission key, each writing nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, idOf, type Caller, type CliWorld } from './api-3-world.ts';
import { madeIds } from './api-5-tracker.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('API-5 tracked actions and keys', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;

  beforeAll(async () => {
    w = await cliWorld('api5audit', 'api5audit');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  const rev = async (id: string): Promise<string> => String(await w.revisionOf(id));

  /**
   * Run one write, then show its applied audit event was written by the same
   * transaction that last wrote its subject: both rows carry that transaction's
   * `now()`, the audit event as `occurred_at` and the record as `updated_at`.
   */
  async function tracked(command: string, subject: string, ...argv: string[]): Promise<string> {
    const answer = await cli.run(...argv);
    expect(answer.exit, answer.out).toBe(0);
    const id = subject === '' ? idOf(answer) : subject;
    const rows = await w.db.admin.execute<{ readonly audit: string; readonly record: string }>(
      `select e.occurred_at::text as audit, r.updated_at::text as record
         from public.audit_events e join public.records r
           on r.business_id = e.business_id and r.id = e.subject_record_id
        where e.business_id = $1 and e.command = $2 and e.subject_record_id = $3
          and e.outcome = 'applied'
        order by e.seq desc limit 1`,
      [w.business, command, id],
    );
    expect(rows, `${command} recorded`).toHaveLength(1);
    expect(rows[0]?.audit, `${command} in the writing transaction`).toBe(rows[0]?.record);
    return answer.out;
  }

  it('API-5 every change it makes is recorded in the writing transaction, and the audited ones join the audit chain', async () => {
    const charted = await cli.run(
      'map',
      'chart',
      '--title',
      'tracked map',
      '--fog',
      JSON.stringify(['tracked fog']),
      '--tickets',
      JSON.stringify([
        { ref: 'a', title: 'tracked a', type: 'research' },
        { ref: 'b', title: 'tracked b', type: 'task' },
      ]),
    );
    expect(charted.exit, charted.out).toBe(0);
    const map = idOf(charted);
    const { a, b } = madeIds(charted.out) as { a: string; b: string };
    const audit = await w.audit();
    expect(audit.some((line) => line.command === 'map.chart' && line.subject === map)).toBe(true);

    const c = idOf({
      exit: 0,
      out: await tracked(
        'task.create',
        '',
        'task',
        'create',
        '--parent',
        map,
        '--title',
        'tracked c',
      ),
    });
    await tracked(
      'task.set_type',
      c,
      'task',
      'type',
      c,
      '--revision',
      await rev(c),
      '--type',
      'grilling',
    );
    await tracked(
      'task.set_blocking',
      b,
      'task',
      'link',
      b,
      '--revision',
      await rev(b),
      '--blocked-by',
      a,
    );
    await tracked('task.claim', a, 'task', 'claim', a, '--revision', await rev(a));
    await tracked(
      'task.resolve',
      a,
      'task',
      'resolve',
      a,
      '--revision',
      await rev(a),
      '--answer',
      'x',
      '--gist',
      'x',
    );
    await tracked(
      'task.close_out_of_scope',
      c,
      'task',
      'out-of-scope',
      c,
      '--revision',
      await rev(c),
      '--reason',
      'past it',
    );
    const patch = await w.db.admin.execute<{ readonly id: string }>(
      `select id::text from public.map_components where map_id = $1 and kind = 'fog' and retired_version is null`,
      [map],
    );
    await tracked(
      'map.graduate',
      map,
      'map',
      'graduate',
      map,
      '--revision',
      await rev(map),
      '--patch',
      patch[0]?.id as string,
      '--tickets',
      JSON.stringify([{ title: 'tracked d', type: 'task' }]),
    );
    await tracked(
      'map.revise',
      map,
      'map',
      'revise',
      map,
      '--revision',
      await rev(map),
      '--notes',
      'tracked notes',
    );
    await tracked('task.complete', b, 'task', 'close', b, '--revision', await rev(b));

    // One unbroken chain: every event's prev_hash is the event before it.
    const broken = await w.db.admin.execute<{ readonly broken: string }>(
      `select count(*)::text as broken from public.audit_events e
         join public.audit_events p on p.business_id = e.business_id and p.seq = e.seq - 1
        where e.business_id = $1 and e.prev_hash is distinct from p.hash`,
      [w.business],
    );
    expect(broken[0]?.broken).toBe('0');
  });

  it('API-5 a refusal per permission key: task:read, task:write, task:assign, task:decide; each writes nothing', async () => {
    const charted = await cli.run(
      'map',
      'chart',
      '--title',
      'keys map',
      '--fog',
      JSON.stringify(['keys fog']),
      '--tickets',
      JSON.stringify([{ ref: 'a', title: 'keys a', type: 'task' }]),
    );
    const map = idOf(charted);
    const { a } = madeIds(charted.out) as { a: string };
    const chartsBefore = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and command = 'map.chart' and outcome = 'applied'`,
      [w.business],
    );
    const none = await w.person(await w.member('holds-comment', ['comment']));
    const reader = await w.person(await w.member('holds-read', ['read']));
    const writer = await w.person(await w.member('holds-write', ['read', 'write']));
    const r = await rev(a);
    const m = await rev(map);
    const cases: [Caller, string[], string][] = [
      [none, ['map', 'frontier', map], 'task:read'],
      [reader, ['map', 'chart', '--title', 'refused chart'], 'task:write'],
      [reader, ['map', 'revise', map, '--revision', m, '--notes', 'no'], 'task:write'],
      [
        reader,
        [
          'map',
          'graduate',
          map,
          '--revision',
          m,
          '--patch',
          a,
          '--tickets',
          '[{"title":"no","type":"task"}]',
        ],
        'task:write',
      ],
      [reader, ['task', 'type', a, '--revision', r, '--type', 'research'], 'task:write'],
      [reader, ['task', 'close', a, '--revision', r], 'task:write'],
      [writer, ['task', 'claim', a, '--revision', r], 'task:assign'],
      [writer, ['task', 'out-of-scope', a, '--revision', r, '--reason', 'no'], 'task:decide'],
    ];
    for (const [caller, argv, key] of cases) {
      const answer = await caller.run(...argv);
      expect(answer.exit, argv.join(' ')).toBe(1);
      expect(answer.out, argv.join(' ')).toContain(key);
    }
    // Nothing moved: the ticket and the map keep their revisions, and no chart was made.
    expect(await rev(a)).toBe(r);
    expect(await rev(map)).toBe(m);
    const made = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and command = 'map.chart' and outcome = 'applied'`,
      [w.business],
    );
    expect(made[0]?.n).toBe(chartsBefore[0]?.n);
  });
});
