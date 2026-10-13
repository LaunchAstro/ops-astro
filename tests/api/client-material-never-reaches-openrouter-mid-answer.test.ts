// SPDX-License-Identifier: AGPL-3.0-only
//
// A client linked to a paid conversation's page while OpenRouter is answering:
// the request already sent carried the page's title and nothing of a client;
// the answer finishes and is kept, and from then on the conversation reaches
// no model: the paid model is no longer offered, cannot be chosen, and a
// later message sends nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { sse } from './openrouter-stand-in-fixture.ts';
import { HAIKU, pricedWorld, type PricedWorld } from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('client material and a paid answer in flight', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_client_mid_answer', undefined, 1, true);
    await p.w.fixture.db.app.withBusiness(p.w.fixture.business, async (tx) => {
      await grantTo(tx, p.w.owner, 'share');
    });
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('a link committed while OpenRouter answers: the answer is kept, then nothing reaches a model', async () => {
    const { db, business } = p.w.fixture;
    const title = `Roster ${randomUUID().slice(0, 8)}`;
    const made = await p.w.as(p.w.owner, 'task.create', { fields: { title } });
    const taskId = String(made.body['recordId']);
    const asked = await p.question('What is left?', undefined, {
      scope: { kind: 'task', id: taskId },
    });
    p.openrouter.answer = () => ({
      status: 200,
      chunks: sse(HAIKU, ['Two ', 'things.']),
      holdAfter: 2,
    });
    const answering = p.ask(asked);
    await p.openrouter.midway();
    const [sent] = p.openrouter.received;
    expect(sent?.raw).toContain(title);
    expect(sent?.raw).not.toContain(taskId);
    const clientId = randomUUID();
    await addClient(db.app, business, clientId, p.w.owner);
    const [task] = await db.admin.execute<{ readonly revision: string }>(
      'select revision::text from public.records where id = $1',
      [taskId],
    );
    expect(
      await executeCommand(db.app, business, p.w.owner.presented, 'api', {
        command: 'task.set_party',
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: Number(task?.revision),
        fields: { client: clientId },
      } as never),
    ).toMatchObject({ recordId: taskId });
    p.openrouter.resume();
    expect(await answering).toMatchObject({ answered: true, body: 'Two things.' });
    const offer = await p.w.as(p.w.owner, 'conversation.models', {
      conversationId: asked.conversationId,
    });
    expect((offer.body as { models: { id: string }[] }).models.map((m) => m.id)).not.toContain(
      HAIKU,
    );
    const later = await p.next(asked.conversationId, 'And the client?');
    expect(await p.ask(later)).toMatchObject({ answered: false });
    expect(p.openrouter.received).toHaveLength(1);
    expect(JSON.stringify(p.openrouter.received)).not.toContain(clientId);
  });
});
