// SPDX-License-Identifier: AGPL-3.0-only
//
// #1467: a paid, carried question in a conversation opened on no task, with a
// task's page added to context, is judged at the handoff and again at the send
// as a conversation opened on that task is. Readable and internal, the
// question is answered and the paid provider gets the page's title. A client
// linked to the task between the offer and the agent's accept sends the
// provider nothing (owner line 72).

import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, linkableTask } from './carried-schedules.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';
import { sendStreaming } from './streamed-reply-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

let world: CarriedWorld | undefined;
afterEach(async () => {
  await world?.close();
  vi.unstubAllEnvs();
});

/** A paid conversation opened on no task, with `task`'s page added; its id and the task's title. */
async function onAddedPage(current: CarriedWorld, task: string) {
  const { fixture, owner } = current.w;
  const [row] = await fixture.db.admin.execute<{ key: string; title: string }>(
    'select txt_1 as key, txt_4 as title from public.records where id = $1',
    [task],
  );
  const opening = `Opened on no task ${randomUUID()}`;
  await (await ask(current, opening, undefined, undefined, HAIKU)).rest();
  const [opened] = await fixture.db.admin.execute<{ id: string }>(
    'select conversation_id as id from public.conversation_messages where body = $1',
    [opening],
  );
  const conversationId = String(opened?.id);
  const page = { address: `/task/${String(row?.key)}`, shows: 'The task' };
  const set = await current.w.as(owner, 'conversation.set_scope', { conversationId, page });
  expect(set.status).toBe(200);
  return { conversationId, title: String(row?.title) };
}

const askAgain = async (current: CarriedWorld, conversationId: string, body: string) =>
  await (
    await sendStreaming(current.api, current.w.owner, 'conversation.message', {
      conversationId,
      body,
    })
  ).rest();

it.skipIf(serverUrl === undefined)(
  'a readable internal task page is sent to the paid provider and the question answered',
  async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const current = await carriedWorld('carried_added_page', undefined, {}, true);
    world = current;
    const { task } = await linkableTask(current);
    const { conversationId, title } = await onAddedPage(current, task);
    const before = current.openrouter?.received.length ?? 0;
    const events = await askAgain(current, conversationId, 'And on this page?');
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: true } });
    expect(current.openrouter?.received).toHaveLength(before + 1);
    expect(JSON.stringify(current.openrouter?.received.at(-1))).toContain(title);
  },
  90_000,
);

it.skipIf(serverUrl === undefined)(
  'a client linked between the offer and the send sends the paid provider nothing',
  async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const current = await carriedWorld('carried_added_page_client', undefined, {}, true);
    world = current;
    const { task, link } = await linkableTask(current);
    const { conversationId, title } = await onAddedPage(current, task);
    const before = current.openrouter?.received.length ?? 0;
    current.agent.beforeAccept = link;
    const events = await askAgain(current, conversationId, 'A client is on its way');
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
    expect(current.openrouter?.received).toHaveLength(before);
    expect(JSON.stringify(current.openrouter?.received ?? [])).not.toContain(title);
  },
  90_000,
);
