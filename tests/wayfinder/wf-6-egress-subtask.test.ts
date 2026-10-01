// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-6 (#639) "On a client map with model egress off, no model call is made
// and the agent says so", one level further down: a subtask filed under a
// ticket of a client map is still that client's work, so the sidebar's
// question on it asks no model, as the ticket's and the map's do
// (wf-6-egress). The subtask's own client link is empty: `map.scope` and the
// chart write the client on the map's direct tickets only.
//
// The model is custody's real process and the replay provider on loopback
// (aw-03-exchange-fixture); the provider's own request log and the stored
// rows are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { localModel, type LocalModel } from '../api/aw-03-exchange-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { appliedDetail, asPerson, revisionOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from '../broker/broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('wf6subtask');

let model: LocalModel;

beforeAll(async () => {
  if (noDatabase) return;
  model = await localModel();
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', undefined, false, 'conversation');
    await grantTo(tx, s.decider, 'read', undefined, false, 'conversation');
  });
}, 180_000);

afterAll(async () => {
  await model?.close();
});

/** A subtask filed under the one ticket of a map scoped to a client. */
async function subtaskOnClientMap(): Promise<string> {
  const charted = await asPerson(s, {
    command: 'map.chart',
    operationId: randomUUID(),
    title: 'wf6 subtask map',
    tickets: [{ ref: 'r1', title: 'wf6 subtask map: what is decided', type: 'research' }],
  });
  const map = String((charted as { recordId: string }).recordId);
  const ticket = String(
    (appliedDetail(charted, 'map.chart')['tickets'] as Record<string, string>)['r1'],
  );
  appliedDetail(
    await asPerson(s, {
      command: 'map.scope',
      operationId: randomUUID(),
      recordId: map,
      expectedRevision: await revisionOf(s, map),
      client: randomUUID(),
    }),
    'map.scope',
  );
  const created = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'wf6 subtask: check the supplier list' },
    parentId: ticket,
  });
  appliedDetail(created, 'task.create');
  return String((created as { recordId: string }).recordId);
}

it('WF-6 egress off: a subtask under a ticket of a client map makes no model call either', async () => {
  const subtask = await subtaskOnClientMap();
  const body = `CANARY-${randomUUID()} about the supplier list`;
  const sent = model.provider.seen.length;
  const opened = appliedDetail(
    await executeCommand(s.db.app, s.business, s.decider.presented, 'api', {
      command: 'conversation.start',
      operationId: randomUUID(),
      body,
      scope: { kind: 'task', id: subtask },
    } as never),
    'conversation.start',
  ) as { conversationId: string; messageId: string };
  const reply = await model.exchange(s.db.app, s.business, s.decider.presented, opened);
  expect(reply).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
  expect(JSON.stringify(reply)).not.toContain(body);
  expect(model.provider.seen.length).toBe(sent);
  const [rows] = await s.db.admin.execute<{ calls: string }>(
    'select count(*)::text as calls from public.model_calls where conversation_id = $1',
    [opened.conversationId],
  );
  expect(Number(rows?.calls)).toBe(0);
}, 180_000);
