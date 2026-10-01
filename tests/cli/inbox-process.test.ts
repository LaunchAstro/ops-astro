// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1d on the command line as a process (C35): `apps/api/server.ts` spawned
// on its own port, and `apps/cli/main.ts` run once per call through the
// command-line process helper. The three inbox operations need nothing but
// their surface rows to be reached here, and answer as the read defines them:
// the count is the list's counted entries, and `seen` stamps the caller's own
// attention row and leaves the item open and counted.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

type Entry = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1d inbox operations as processes', () => {
  let world: World;
  let api: ServedApi | undefined;
  let item = '';

  const as = (token: string) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
  });

  beforeAll(async () => {
    world = await createWorld('i1dp');
    api = await serveApi(world);
    const created = await runCli(
      [
        'task.create',
        '--json',
        JSON.stringify({ operationId: randomUUID(), fields: { title: 'cli inbox' } }),
      ],
      as(world.ada.token),
    );
    const task = String(created.json?.['recordId']);
    item = await world.db.app.withBusiness(
      world.alpha,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: String(world.ada.personId),
          subjectRecordId: task,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    await world?.close();
  }, 60_000);

  it('reads, counts and stamps through separate command-line processes', async () => {
    const listed = await runCli(['inbox.read'], as(world.ada.token));
    expect(listed.code, listed.stderr).toBe(0);
    const entries = (listed.json?.['inbox'] ?? []) as readonly Entry[];
    expect(entries.find((e) => e['id'] === item)).toMatchObject({ counted: true, seenAt: null });

    const counted = await runCli(['inbox.count'], as(world.ada.token));
    expect(counted.code, counted.stderr).toBe(0);
    expect(counted.json?.['owed']).toBe(entries.filter((e) => e['counted'] === true).length);

    const stamped = await runCli(
      ['inbox.seen', '--json', JSON.stringify({ operationId: randomUUID(), itemId: item })],
      as(world.ada.token),
    );
    expect(stamped.code, stamped.stderr).toBe(0);
    const after = await runCli(['inbox.read'], as(world.ada.token));
    const opened = ((after.json?.['inbox'] ?? []) as readonly Entry[]).find(
      (e) => e['id'] === item,
    );
    expect(opened).toMatchObject({ counted: true, workState: 'open' });
    expect(opened?.['seenAt']).toEqual(expect.any(String));
  }, 60_000);

  it('refuses another person’s stamp as a process, and writes nothing', async () => {
    const run = await runCli(
      ['inbox.seen', '--json', JSON.stringify({ operationId: randomUUID(), itemId: item })],
      as(world.mia.token),
    );
    expect(run.code).not.toBe(0);
    expect(run.json?.['code']).toBe('NOT_FOUND');
    const rows = await world.db.admin.execute<{ person_id: string }>(
      `select person_id from public.inbox_attention where item_id = $1`,
      [item],
    );
    expect(rows.map((row) => row.person_id)).toStrictEqual([world.ada.personId]);
  }, 60_000);
});
