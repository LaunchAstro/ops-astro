// SPDX-License-Identifier: AGPL-3.0-only
//
// U116 parity: `task get --history-event` sends `historyEventId` to the same
// `task.read` the app and the API call, and answers the entry the history
// holds, named fields and all. The CLI adds no rule of its own.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, idOf, revisionIn, type Caller, type CliWorld } from './api-3-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const json = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>;

describe.skipIf(serverUrl === undefined)('U116 history lookup on the command line', () => {
  let w: CliWorld;
  let cli: Caller;

  beforeAll(async () => {
    w = await cliWorld('u116cli', 'u116cli');
    cli = await w.person(await w.member('Mia', ['read', 'write']));
  }, 180_000);
  afterAll(async () => {
    await w?.drop();
  });

  it('task get --history-event answers the entry the full history holds', async () => {
    const created = await cli.run('task', 'create', '--title', 'before');
    const id = idOf(created);
    const renamed = await cli.run(
      'task',
      'update',
      id,
      '--revision',
      revisionIn(created),
      '--title',
      'after',
    );
    expect(renamed.exit, renamed.out).toBe(0);
    const full = json((await cli.run('task', 'get', id, '--detail', 'full', '--json')).out);
    const latest = (full['history'] as Record<string, unknown>[]).at(-1);
    expect(latest).toMatchObject({
      operation: 'task.update',
      changed: ['title'],
      actorName: 'Mia',
    });
    const eventId = String(latest?.['eventId']);

    const found = await cli.run('task', 'get', id, '--history-event', eventId, '--json');
    expect(found.exit, found.out).toBe(0);
    expect(json(found.out)['historyEvent']).toStrictEqual(latest);
    const missing = await cli.run('task', 'get', id, '--history-event', randomUUID(), '--json');
    expect(json(missing.out)['historyEvent']).toBeNull();

    // A level that carries no history is the server's refusal, not the CLI's.
    const brief = await cli.run('task', 'get', id, '--detail', 'brief', '--history-event', eventId);
    expect(brief.exit).toBe(1);
    expect(brief.out).toContain('FIELD_VALUE_INVALID');
  });
});
