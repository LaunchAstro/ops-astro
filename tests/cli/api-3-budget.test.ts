// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- calls in order; one fixture map, one case per budget line */
//
// API-3's token budgets (CAPABILITY-SLICES section 15a), counted by the
// suite's fixed local tokenizer over a seeded fixture map of 40 tickets with
// realistic threads. Targets for waste, never caps on correctness: a line that
// would cut what the work needs is raised in the ticket's handback instead.
// *Map status* and *work this ticket* are API-4's (`context`, `map status`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { countTokens } from '../support/token-count.ts';
import { cliWorld, idOf, revisionIn, type Caller, type CliWorld } from './api-3-world.ts';
import { must } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();

const TICKETS = 40;
const TYPES = ['research', 'task', 'build', 'grilling', 'prototype'] as const;
const THREAD = [
  'Checked the current import path: the parser rejects rows with a blank client code, which is most of the March export.',
  'Agreed. We keep the rejection but report the row numbers so the owner can fix them in the sheet before the next run.',
  'Done in the draft; the report lists each skipped row with its reason in one line.',
];

describe.skipIf(serverUrl === undefined)('API-3 budgets', () => {
  let w: CliWorld;
  let cli: Caller;
  let tickets: string[] = [];
  const report: string[] = [];

  beforeAll(async () => {
    w = await cliWorld('api3bud', 'api3bud');
    const lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
    const map = must(
      await w.as(lead, {
        command: 'task.create',
        fields: { title: 'Fixture map: client import rebuild' },
        taskType: 'map',
      }),
      'map',
    ).id;
    tickets = [];
    for (let at = 0; at < TICKETS; at += 1) {
      const ticket = must(
        await w.as(lead, {
          command: 'task.create',
          fields: {
            title: `Ticket ${String(at + 1)}: rebuild step ${String(at + 1)} of the client import`,
            description:
              'Make the import report every skipped row with its reason, and keep the rest of the run going.',
          },
          taskType: TYPES[at % TYPES.length],
          parentId: map,
        }),
        'ticket',
      ).id;
      for (const body of THREAD) {
        must(
          await w.as(lead, {
            command: 'task.comment',
            recordId: ticket,
            expectedRevision: await w.revisionOf(ticket),
            audience: 'internal',
            body,
          }),
          'comment',
        );
      }
      tickets.push(ticket);
    }
  }, 600_000);

  afterAll(async () => {
    console.info(['API-3 budget report', ...report].join('\n'));
    await w?.drop();
  });

  it("API-3 budget: a write's default result is under 150 tokens", async () => {
    const id = idOf(await cli.run('task', 'create', '--title', 'budget write'));
    const other = idOf(await cli.run('task', 'create', '--title', 'budget blocker'));
    const writes = [
      await cli.run('task', 'create', '--title', 'budget write two', '--parent', id),
      await cli.run(
        'task',
        'comment',
        id,
        '--revision',
        String(await w.revisionOf(id)),
        '--text',
        THREAD[0] as string,
      ),
    ];
    const updated = await cli.run(
      'task',
      'update',
      id,
      '--revision',
      String(await w.revisionOf(id)),
      '--title',
      'budget write, renamed',
    );
    const linked = await cli.run(
      'task',
      'link',
      id,
      '--blocked-by',
      other,
      '--revision',
      revisionIn(updated),
    );
    const resolved = await cli.run(
      'task',
      'resolve',
      id,
      '--revision',
      revisionIn(linked),
      '--answer',
      'done',
      '--gist',
      'done',
    );
    const largest = Math.max(
      ...[...writes, updated, linked, resolved].map((answer) => {
        expect(answer.exit, answer.out).toBe(0);
        return countTokens(answer.out);
      }),
    );
    report.push(`write result, largest: ${String(largest)} (target under 150)`);
    expect(largest).toBeLessThan(150);
  });

  it('API-3 budget: a brief read is under 300 tokens', async () => {
    const one = await cli.run('task', 'get', tickets[0] as string, '--detail', 'brief');
    expect(one.exit, one.out).toBe(0);
    const page = await cli.run('task', 'list', '--detail', 'brief', '--limit', '20');
    expect(page.exit, page.out).toBe(0);
    const [single, list] = [countTokens(one.out), countTokens(page.out)];
    // Raised in the ticket's handback: a page of 20 needs each item's id and
    // name, and a uuid alone is about 20 tokens on any byte-pair tokenizer, so
    // 300 for 20 would cut what the work needs. The line is 1,000 for a page.
    report.push(
      `brief read of one task: ${String(single)} (target under 300)`,
      `brief page of 20: ${String(list)} (target raised to under 1,000)`,
    );
    expect(single).toBeLessThan(300);
    expect(list).toBeLessThan(1_000);
  });

  it('API-3 budget: a standard read of one task is under 800 tokens at the 95th percentile', async () => {
    const counts: number[] = [];
    for (const ticket of tickets) {
      const answer = await cli.run('task', 'get', ticket);
      expect(answer.exit, answer.out).toBe(0);
      counts.push(countTokens(answer.out));
    }
    const p95 = counts.toSorted((a, b) => a - b)[Math.ceil(counts.length * 0.95) - 1] ?? 0;
    report.push(`standard task read, p95: ${String(p95)} (target under 800)`);
    expect(p95).toBeLessThan(800);
  });
});
