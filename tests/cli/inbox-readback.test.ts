// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1g: inbox items read back identically after a restart (supporting
// checklist: "Inbox items read back identically after the API, the worker and
// the browser restart"). The API is a real process, stopped and replaced by a
// second one started from the same tree; the browser is the web's client
// module, a fresh instance after the restart, as a reloaded page builds one.
// The worker's leg waits on T2b's worker process, which is not on this base.
//
// The inbox before the restart holds every axis at once: an open mention
// that was seen and delivered, a decision cleared by a named decider, and a
// finished run that is owed nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raiseInboxItem, recordDeliveryAttempt } from '../../packages/core-records/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { InboxEntry, InboxReadResult } from '../../packages/core-wire/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type ServedApi } from './cli-process-harness.ts';

describe.skipIf(serverUrl === undefined)('INB-1g the inbox reads back after a restart', () => {
  let world: World;
  let api: ServedApi | undefined;

  const post = async (path: string, token: string, body: Record<string, unknown>) => {
    const response = await fetch(`${(api as ServedApi).origin}/api/b/alpha${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationId: randomUUID(), ...body }),
    });
    const answer = (await response.json()) as Record<string, unknown>;
    return { ...answer, ...(answer['detail'] as Record<string, unknown> | undefined) };
  };
  const browserRead = async (token: string): Promise<readonly InboxEntry[]> => {
    const client = new OperationsClient({
      origin: (api as ServedApi).origin,
      businessKey: 'alpha',
      token,
      fetch: globalThis.fetch.bind(globalThis),
    });
    const read = await client.read<InboxReadResult>('inbox.read', {});
    if (!('value' in read)) throw new Error(`inbox.read failed: ${JSON.stringify(read)}`);
    return read.value.inbox;
  };
  const cliRead = async (token: string): Promise<unknown> => {
    const run = await runCli(['inbox.read'], {
      OPS_ASTRO_API_URL: (api as ServedApi).origin,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: token,
    });
    expect(run.code, run.stderr).toBe(0);
    return run.json?.['inbox'];
  };

  beforeAll(async () => {
    world = await createWorld('i1grb');
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    await world?.close();
  }, 60_000);

  it('INB-1 inbox items read back identically after the API and the browser restart', async () => {
    const created = await post('/task/create', world.mia.token, { fields: { title: 'read back' } });
    const taskId = String(created['recordId']);
    const ada = String(world.ada.personId);
    const mention = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const id = await raiseInboxItem(tx, {
        recipientPersonId: ada,
        subjectRecordId: taskId,
        reason: 'mention',
        fact: { kind: 'record', id: randomUUID() },
      });
      await recordDeliveryAttempt(tx, { itemId: id, channel: 'in_app', state: 'delivered' });
      await raiseInboxItem(tx, {
        recipientPersonId: ada,
        subjectRecordId: taskId,
        reason: 'run_finished',
        fact: { kind: 'planned_run', id: randomUUID() },
      });
      return id;
    });
    await post('/inbox/seen', world.ada.token, { itemId: mention });
    const proposed = await post('/task/propose', world.mia.token, {
      recordId: taskId,
      expectedRevision: Number(created['revision']),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    });
    await post('/task/decide', world.ada.token, {
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'decided before the restart',
    });

    const before = await browserRead(world.ada.token);
    const cliBefore = await cliRead(world.ada.token);
    expect(before.map((e) => [e.reason, e.workState])).toEqual(
      expect.arrayContaining([
        ['mention', 'open'],
        ['run_finished', 'open'],
        ['decision', 'cleared'],
      ]),
    );
    expect(before.find((e) => e.id === mention)).toMatchObject({
      lastDelivery: 'delivered',
      seenAt: expect.any(String),
      counted: true,
    });

    const first = (api as ServedApi).pid;
    await (api as ServedApi).stop();
    api = await serveApi(world);
    expect((api as ServedApi).pid).not.toBe(first);

    expect(await browserRead(world.ada.token)).toStrictEqual(before);
    expect(await cliRead(world.ada.token)).toStrictEqual(cliBefore);
  }, 180_000);
});
