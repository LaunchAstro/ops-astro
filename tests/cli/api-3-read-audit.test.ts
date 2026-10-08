// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- one read at a time, each counted; one suite over one world */
//
// API-3's reads and the audit chain. The ticket's line TR-S-B3-1 ("reads add
// no audit event") is stale: every read writes an audit event under I13
// (`reads/dispatch.ts`; `docs/local/API.md`, "Every read writes an audit
// event"), decided for this slice by the orchestrator on 29 Sep 2026. This
// suite holds each agent CLI read to exactly its one event, applied or
// refused, read back from `audit_events`. API-4's reads (map status, context,
// changes) join it as they land.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, idOf, type Caller, type CliWorld } from './api-3-world.ts';
import { grantTo } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('API-3 reads and the audit chain', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;
  let map: string;
  let ticket: string;

  beforeAll(async () => {
    w = await cliWorld('api3audit', 'api3audit');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    await w.db.app.withBusiness(w.business, (tx) =>
      grantTo(tx, lead, 'read', undefined, false, 'person'),
    );
    cli = await w.person(lead);
    map = idOf(await cli.run('task', 'create', '--title', 'audited map', '--type', 'map'));
    ticket = idOf(
      await cli.run(
        'task',
        'create',
        '--title',
        'audited ticket',
        '--parent',
        map,
        '--type',
        'task',
      ),
    );
  }, 180_000);

  afterAll(async () => await w?.drop());

  const reads: readonly (readonly [string, () => readonly string[]])[] = [
    ['task.read', () => ['task', 'get', ticket]],
    ['task.board', () => ['task', 'list']],
    ['map.view', () => ['map', 'view', map]],
    ['map.frontier', () => ['map', 'frontier', map]],
  ];

  /** Run one read and return the audit events it added, in chain order. */
  async function added(caller: Caller, argv: readonly string[]) {
    const before = (await w.audit()).length;
    const answer = await caller.run(...argv);
    return { answer, events: (await w.audit()).slice(before) };
  }

  it('API-3 each read writes exactly its one audit event', async () => {
    for (const [read, argv] of reads) {
      const { answer, events } = await added(cli, argv());
      expect(answer.exit, `${read}: ${answer.out}`).toBe(0);
      expect(events.map((event) => [event.command, event.outcome])).toStrictEqual([
        [read, 'applied'],
      ]);
    }
  });

  it('API-3 a refused read writes exactly its one audit event, refused', async () => {
    const stranger = await w.person(await w.member('stranger', ['comment']));
    for (const [read, argv] of reads) {
      const { answer, events } = await added(stranger, argv());
      expect(answer.exit, `${read}: ${answer.out}`).not.toBe(0);
      expect(events.map((event) => [event.command, event.outcome])).toStrictEqual([
        [read, 'refused'],
      ]);
    }
  });
  it('the shipped CLI preserves aggregate and selected identity scopes through the real API', async () => {
    for (const destination of [{ mode: 'aggregate' }, { board: map }, { board: null }] as const) {
      const argv =
        'mode' in destination
          ? ['--mode', destination.mode]
          : destination.board === null
            ? []
            : ['--board', destination.board];
      // eslint-disable-next-line no-await-in-loop -- each CLI read is compared to the same canonical dispatcher.
      const answer = await cli.run('task', 'list', ...argv, '--person', lead.personId, '--json');
      expect(answer.exit, answer.out).toBe(0);
      // eslint-disable-next-line no-await-in-loop -- compare identical declared read operands.
      const direct = await executeRead(w.db.app, w.business, lead.presented, {
        read: 'task.board',
        ...destination,
        person: lead.personId,
        detail: 'standard',
      });
      if (!('page' in direct))
        throw new Error(`Expected canonical board page ${JSON.stringify(direct)}`);
      expect(JSON.parse(answer.out)).toEqual({
        items: direct.page,
        ...(direct.next === null ? {} : { next: direct.next }),
      });
    }
    const answer = await cli.run(
      'task',
      'list',
      '--mode',
      'aggregate',
      '--board',
      map,
      '--person',
      lead.personId,
      '--json',
    );
    expect(answer.exit).toBe(1);
    expect(answer.out).toContain('FIELD_VALUE_INVALID');
  });
});
