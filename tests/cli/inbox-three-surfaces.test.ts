// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1g: the owed count is one number on the three surfaces (supporting
// checklist: "Only owed items are counted ... the count is equal across this
// ticket's working minimum, the API and the command line, and it drops inside
// the deciding transaction"; and "The inbox read and count exist on the
// browser, the API and the command-line process").
//
// One served API process (`apps/api/server.ts` on its own port). The working
// minimum is the web's own client module, the one the board screen's inbox
// calls, pointed at that process; the command line is `apps/cli/main.ts` run
// once per call; the API is a plain HTTP post. A no-response item (a finished
// run) sits in the inbox the whole time and is never counted. No worker runs.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { InboxCountResult, InboxReadResult } from '../../packages/core-wire/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

// eslint-disable-next-line max-lines-per-function -- one mounted screen, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1g the owed count on three surfaces', () => {
  let world: World;
  let api: ServedApi | undefined;

  const served = (): ServedApi => api as ServedApi;
  const env = (token: string) => ({
    OPS_ASTRO_API_URL: served().origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
  });
  const post = async (path: string, token: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${served().origin}/api/b/alpha${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  const web = (token: string) =>
    new OperationsClient({
      origin: served().origin,
      businessKey: 'alpha',
      token,
      fetch: globalThis.fetch.bind(globalThis),
    });

  /** The count on each surface, and the counted entries of the web's list. */
  const counts = async (token: string) => {
    const client = web(token);
    const listed = await client.read<InboxReadResult>('inbox.read', {});
    const counted = await client.read<InboxCountResult>('inbox.count', {});
    if (!('value' in listed) || !('value' in counted)) {
      throw new Error(`web read failed: ${JSON.stringify([listed, counted])}`);
    }
    const cli = await runCli(['inbox.count'], env(token));
    expect(cli.code, cli.stderr).toBe(0);
    return {
      webList: listed.value.inbox.filter((entry) => entry.counted).length,
      web: counted.value.owed,
      api: Number((await post('/inbox/count', token))['owed']),
      cli: Number(cli.json?.['owed']),
      noResponse: listed.value.inbox.filter((entry) => entry.reason === 'run_finished'),
    };
  };

  beforeAll(async () => {
    world = await createWorld('i1g3');
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    await world?.close();
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- one mounted screen, and the cases that share it
  it('INB-1 only owed items are counted: the count is equal on the working minimum, the API and the command line, and drops on the deciding commit', async () => {
    const created = await post('/task/create', world.mia.token, {
      operationId: randomUUID(),
      fields: { title: 'three surfaces' },
    });
    const taskId = String(created['recordId']);
    await world.db.app.withBusiness(
      world.alpha,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: String(world.ada.personId),
          subjectRecordId: taskId,
          reason: 'run_finished',
          fact: { kind: 'planned_run', id: randomUUID() },
        }),
    );
    const proposed = await post('/task/propose', world.mia.token, {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: Number(created['revision']),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    const detail = (proposed['detail'] as Record<string, unknown> | undefined) ?? proposed;

    const before = await counts(world.ada.token);
    expect(before.noResponse).toHaveLength(1);
    expect(before.noResponse[0]).toMatchObject({ counted: false, owed: false });
    expect(before.web).toBeGreaterThan(0);
    expect([before.webList, before.api, before.cli]).toStrictEqual([
      before.web,
      before.web,
      before.web,
    ]);

    const decided = await post('/task/decide', world.ada.token, {
      operationId: randomUUID(),
      gateId: detail['gateId'],
      versionId: detail['versionId'],
      decision: 'approve',
      note: 'decided on the second surface',
    });
    expect(decided['refused'], JSON.stringify(decided)).toBeUndefined();

    const after = await counts(world.ada.token);
    expect(after.web).toBe(before.web - 1);
    expect([after.webList, after.api, after.cli]).toStrictEqual([after.web, after.web, after.web]);
    expect(after.noResponse).toHaveLength(1);
  }, 120_000);
});
