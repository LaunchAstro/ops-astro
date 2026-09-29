// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-1 from the command line: one case per command the ticket adds, each
// through the generated client over the composed API (`createCli` with the
// in-process app as transport), checked against what the database holds and
// against the envelope's own answer to the same refused call.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createCli, type CliAnswer, type Transport } from '../../apps/cli/client.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { createApiFixture, BUSINESS_KEY, tokenFor, type ApiFixture } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Body = Readonly<Record<string, unknown>>;

describe.skipIf(serverUrl === undefined)('WF-1 from the command line', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let cli: ReturnType<typeof createCli>;

  const run = async (verb: string, body: Body): Promise<CliAnswer> =>
    await cli.run(verb, verb === 'map.view' ? body : { operationId: randomUUID(), ...body });
  const field = (answer: CliAnswer, key: string): unknown => (answer.body as Body)[key];
  const revisionOf = async (id: string): Promise<number> =>
    Number(
      (
        await fixture.db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from public.records where business_id = $1 and id = $2`,
          [fixture.business, id],
        )
      )[0]?.revision,
    );

  beforeAll(async () => {
    fixture = await createApiFixture('wf1cli');
    api = fixture.compose();
    const credential = await tokenFor(fixture.member.presented.subject);
    const transport: Transport = async (path, body, bearer) =>
      await api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body,
        }),
      );
    cli = createCli({ transport, businessKey: BUSINESS_KEY, credential });
  }, 180_000);

  afterAll(async () => await fixture?.drop());

  it('WF-1 CLI task.create files a map and a typed ticket under it', async () => {
    const map = await run('task.create', { fields: { title: 'cli map' }, taskType: 'map' });
    expect(map.status).toBe(200);
    const mapId = String(field(map, 'recordId'));
    const ticket = await run('task.create', {
      fields: { title: 'cli research' },
      taskType: 'research',
      parentId: mapId,
    });
    expect(ticket.status).toBe(200);
    const rows = await fixture.db.admin.execute<{ readonly type: string; readonly parent: string }>(
      `select data->>'type' as type, data->>'parent' as parent from public.records
        where business_id = $1 and id = $2`,
      [fixture.business, String(field(ticket, 'recordId'))],
    );
    expect(rows[0]).toStrictEqual({ type: 'research', parent: mapId });
  });

  it('WF-1 CLI map.revise and map.view show the sections, the same as the envelope', async () => {
    const map = String(
      field(
        await run('task.create', { fields: { title: 'cli sections' }, taskType: 'map' }),
        'recordId',
      ),
    );
    const revised = await run('map.revise', {
      recordId: map,
      expectedRevision: await revisionOf(map),
      destination: 'a destination',
      addFog: ['patch one', 'patch two'],
    });
    expect(revised.status).toBe(200);
    const shown = await run('map.view', { recordId: map });
    expect(shown.status).toBe(200);
    const view = field(shown, 'map') as {
      destination: { text: string };
      fog: readonly { text: string }[];
      version: number;
    };
    expect(view.destination.text).toBe('a destination');
    expect(view.fog.map((p) => p.text)).toStrictEqual(['patch one', 'patch two']);
    expect(view.version).toBe(1);

    // The same refusal on both paths: a stale revision.
    const cliRefusal = await run('map.revise', { recordId: map, expectedRevision: 1, notes: 'x' });
    const direct = await executeCommand(
      fixture.db.app,
      fixture.business,
      fixture.member.presented,
      'api',
      {
        command: 'map.revise',
        operationId: randomUUID(),
        recordId: map,
        expectedRevision: 1,
        notes: 'x',
      } as never,
    );
    expect(field(cliRefusal, 'code')).toBe('VERSION_STALE');
    expect((direct as { code?: string }).code).toBe('VERSION_STALE');
    expect(field(cliRefusal, 'names')).toStrictEqual((direct as { names?: unknown }).names);
  });

  it('WF-1 CLI map.scope carries the client to the map', async () => {
    const map = String(
      field(
        await run('task.create', { fields: { title: 'cli scoped' }, taskType: 'map' }),
        'recordId',
      ),
    );
    const client = randomUUID();
    const scoped = await run('map.scope', {
      recordId: map,
      expectedRevision: await revisionOf(map),
      client,
    });
    expect(scoped.status).toBe(200);
    expect(
      (field(await run('map.view', { recordId: map }), 'map') as { client: string }).client,
    ).toBe(client);
  });

  it('WF-1 CLI task.set_type retypes a ticket and refuses an unknown type', async () => {
    const map = String(
      field(
        await run('task.create', { fields: { title: 'cli types' }, taskType: 'map' }),
        'recordId',
      ),
    );
    const ticket = String(
      field(
        await run('task.create', { fields: { title: 't' }, taskType: 'research', parentId: map }),
        'recordId',
      ),
    );
    const retyped = await run('task.set_type', {
      recordId: ticket,
      expectedRevision: await revisionOf(ticket),
      taskType: 'grilling',
    });
    expect(retyped.status).toBe(200);
    const odd = await run('task.set_type', {
      recordId: ticket,
      expectedRevision: await revisionOf(ticket),
      taskType: 'epic',
    });
    expect(field(odd, 'code')).toBe('FIELD_VALUE_INVALID');
    expect(field(odd, 'names')).toStrictEqual(['taskType']);
  });
});
