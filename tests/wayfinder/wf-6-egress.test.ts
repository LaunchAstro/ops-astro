// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-6 (#639) "On a client map with model egress off, no model call is made
// and the agent says so." The sidebar's conversation on a map is a
// conversation scoped to the map's task (AW-03, 0198); its answer comes
// through AW-03's exchange and AW-01's conversation seam, which take a local
// route only. A client's material goes to no model at all (C60): the seam
// reads the scoped task's client link, the one `map.scope` writes on a map
// and every ticket under it, and refuses before any route, so even a local
// model is asked nothing. The ticket run's refusal is wf-7-egress.
//
// The model is custody's real process and the replay provider on loopback
// (aw-03-exchange-fixture); the provider's own request log and the stored
// rows are the oracle.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { localModel, type LocalModel } from '../api/aw-03-exchange-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { appliedDetail, asPerson, revisionOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from '../broker/broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('wf6egress');

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

const chartMap = async (title: string): Promise<{ map: string; ticket: string }> => {
  const outcome = await asPerson(s, {
    command: 'map.chart',
    operationId: randomUUID(),
    title,
    tickets: [{ ref: 'r1', title: `${title}: what is decided`, type: 'research' }],
  });
  const tickets = appliedDetail(outcome, 'map.chart')['tickets'] as Record<string, string>;
  return { map: String((outcome as { recordId: string }).recordId), ticket: String(tickets['r1']) };
};

const scope = async (map: string, client: string | null): Promise<void> => {
  appliedDetail(
    await asPerson(s, {
      command: 'map.scope',
      operationId: randomUUID(),
      recordId: map,
      expectedRevision: await revisionOf(s, map),
      client,
    }),
    'map.scope',
  );
};

/** The sidebar's question on a record: a conversation scoped to it, and the exchange's answer. */
async function askOn(
  record: string,
  body: string,
): Promise<{ conversationId: string; reply: ConversationReply | null }> {
  const opened = await executeCommand(s.db.app, s.business, s.decider.presented, 'api', {
    command: 'conversation.start',
    operationId: randomUUID(),
    body,
    scope: { kind: 'task', id: record },
  } as never);
  const asked = appliedDetail(opened, 'conversation.start') as {
    conversationId: string;
    messageId: string;
  };
  const reply = await model.exchange(s.db.app, s.business, s.decider.presented, {
    conversationId: asked.conversationId,
    messageId: asked.messageId,
  });
  return { conversationId: asked.conversationId, reply };
}

const rowsIn = async (conversationId: string): Promise<{ calls: number; replies: number }> => {
  const [row] = await s.db.admin.execute<{ calls: string; replies: string }>(
    `select (select count(*) from public.model_calls where conversation_id = $1) as calls,
            (select count(*) from public.conversation_messages
              where conversation_id = $1 and role = 'agent') as replies`,
    [conversationId],
  );
  return { calls: Number(row?.calls), replies: Number(row?.replies) };
};

/** Refused before any route: the provider asked nothing, nothing written, the words say why. */
async function expectNoCall(record: string, title: string): Promise<void> {
  const body = `CANARY-${randomUUID()} about ${title}`;
  const sent = model.provider.seen.length;
  const { conversationId, reply } = await askOn(record, body);
  expect(reply).toMatchObject({ answered: false, code: 'CLIENT_MODEL_USE_OFF' });
  expect(reply?.answered === false ? reply.words : '').toContain("this client's work");
  expect(JSON.stringify(reply)).not.toContain(body);
  expect(JSON.stringify(reply)).not.toContain(title);
  expect(model.provider.seen.length).toBe(sent);
  expect(await rowsIn(conversationId)).toStrictEqual({ calls: 0, replies: 0 });
}

it('WF-6 egress off: on a map scoped to a client, the sidebar makes no model call and says so', async () => {
  const { map } = await chartMap('wf6 client map');
  await scope(map, randomUUID());
  await expectNoCall(map, 'wf6 client map');
}, 180_000);

it('WF-6 egress off: a ticket under a client map makes no model call either', async () => {
  const { map, ticket } = await chartMap('wf6 client ticket');
  await scope(map, randomUUID());
  await expectNoCall(ticket, 'wf6 client ticket');
}, 180_000);

it('WF-6 egress off: a map with no client, or its client cleared, is answered by the local model', async () => {
  const { map } = await chartMap('wf6 own map');
  const sent = model.provider.seen.length;
  const own = await askOn(map, 'What is still open on this map?');
  expect(own.reply).toMatchObject({ answered: true });
  expect(model.provider.seen.length).toBe(sent + 1);

  await scope(map, randomUUID());
  await scope(map, null);
  const cleared = await askOn(map, 'And now?');
  expect(cleared.reply).toMatchObject({ answered: true });
  expect(await rowsIn(cleared.conversationId)).toStrictEqual({ calls: 1, replies: 1 });
}, 180_000);
