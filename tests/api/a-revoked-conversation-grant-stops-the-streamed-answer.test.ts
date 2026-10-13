// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { parseCredentials } from '../../packages/core-custody/src/index.ts';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  chatAnswer,
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming } from './streamed-reply-fixture.ts';

const CANARY = 'private-answer-after-revocation-1535';
let ollama: StandIn;
let broker: Awaited<ReturnType<typeof ollamaBroker>>;
let world: ConversationWorld;

beforeAll(async () => {
  vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
  ollama = await standInOllama();
  // Each revision uses its supported documented credential shape.
  const none = parseCredentials([
    { ref: 'probe', kind: 'api_key', account: 'here', destination: 'ollama', scheme: 'none' },
  ]).ok;
  broker = await ollamaBroker(ollama.origin, none ? 'none' : 'token');
  const fixture = await createApiFixture('revoked_stream');
  world = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
  ollama.reply = (model) => {
    const streamed = (JSON.parse(ollama.seen.at(-1)?.raw ?? '{}') as { stream?: boolean }).stream;
    return streamed
      ? { status: 200, chunks: streamedLines(model, [CANARY]) }
      : chatAnswer(model, CANARY);
  };
}, 180_000);

afterAll(async () => {
  await broker?.stop();
  await ollama?.close();
  await world?.drop();
  vi.unstubAllEnvs();
});

it('revoked conversation authority prevents subsequent answer disclosure', async () => {
  ollama.shut();
  const sending = sendStreaming(world.api, world.owner, 'conversation.start', {
    body: 'What is due?',
  });
  await ollama.arrived(1);
  // Revocation commits before the provider emits any answer bytes.
  await world.fixture.db.app.withBusiness(world.fixture.business, async (tx) => {
    const grants = await tx.query<{ id: string }>(
      "select id from public.grants where subject_id = $1 and collection = 'conversation' and action = 'write' and revoked_at is null",
      [world.owner.personId],
    );
    expect(grants).toHaveLength(1);
    // oxlint-disable-next-line no-await-in-loop -- one revocation after another, in one transaction
    for (const grant of grants) expect(await revokeGrant(tx, grant.id)).not.toBeNull();
  });
  ollama.open();
  const response = await sending;
  const received = response.contentType?.startsWith('text/event-stream')
    ? JSON.stringify(await response.rest())
    : await response.text();
  const rows = await world.fixture.db.admin.execute(
    "select body from public.conversation_messages where role = 'agent'",
  );
  expect(rows).toHaveLength(0);
  expect(received).not.toContain(CANARY);
}, 60_000);
