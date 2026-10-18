// SPDX-License-Identifier: AGPL-3.0-only
//
// #1467: a paid, carried question in a conversation opened on no task, with a
// task's page added to context, is judged at the handoff and again at the send
// as a conversation opened on that task is. Readable and internal, the
// question is answered and the paid provider gets the page's title. A client
// linked to the task between the offer and the agent's accept sends the
// provider nothing (owner line 72).

import { randomUUID } from 'node:crypto';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
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
  'replacing an added page cannot send the old page after a client is linked',
  async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    const current = await carriedWorld('carried_page_race', undefined, {}, true);
    world = current;
    const { task, link } = await linkableTask(current);
    const { conversationId, title } = await onAddedPage(current, task);
    const before = current.openrouter?.received.length ?? 0;
    current.agent.beforeAccept = async () => {
      await link();
      const own = connect(current.w.fixture.db.appUrl, { source: 'runtime' });
      try {
        const changed = await executeCommand(
          own,
          current.w.fixture.business,
          current.w.owner.presented,
          'api',
          {
            command: 'conversation.set_scope',
            operationId: randomUUID(),
            conversationId,
            page: { address: '/board', shows: 'Board' },
          } as never,
        );
        expect(changed).toMatchObject({ detail: { conversationId } });
      } finally {
        await own.close();
      }
    };
    await askAgain(current, conversationId, 'Review the task on my added page');
    expect(JSON.stringify(current.openrouter?.received.slice(before) ?? [])).not.toContain(title);
  },
  90_000,
);
