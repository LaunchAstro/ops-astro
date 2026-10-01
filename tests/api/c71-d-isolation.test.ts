// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-D isolation (standing gate 9), over the real HTTP routes: two
// businesses, two clients in each with one grant each (a share of one task),
// and a direct conversation with its own canary body in each business.
// Another business's or another person's conversation is never read, listed,
// counted or changed, and a canary never appears in a foreign response.

// oxlint-disable no-await-in-loop -- one caller at a time, each read back
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Answer } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

type Body = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one world, the four crossings
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-D isolation', () => {
  let chat: ChatWorld;
  const alphaCanary = `alpha-canary-${randomUUID()}`;
  const bravoCanary = `bravo-canary-${randomUUID()}`;
  let alphaConversation: string;
  let bravoConversation: string;

  /** Both conversations' member rows, markers included, read past row security. */
  const markers = async (): Promise<string> =>
    JSON.stringify(
      await chat.harness.world.db.admin.execute(
        `select conversation_id, person_id, last_read_at, left_at
           from public.team_conversation_members order by 1, 2`,
      ),
    );
  const clean = (answer: Answer, label: string): void => {
    expect(answer.text, label).not.toContain(alphaCanary);
    expect(answer.text, label).not.toContain(bravoCanary);
  };
  const conversationOf = (answer: Answer): string =>
    String((answer.body['detail'] as Body)['conversationId']);

  beforeAll(async () => {
    chat = await createChatWorld('c71diso');
    const { world } = chat.harness;
    alphaConversation = conversationOf(await chat.send(world.ada, world.mia, alphaCanary));
    bravoConversation = conversationOf(await chat.send(world.bea, chat.bo, bravoCanary));
  }, 180_000);

  afterAll(async () => {
    await chat?.harness.close();
  });

  it('C71-D isolation: another business’s conversation is never read, listed, counted or changed', async () => {
    const { world } = chat.harness;
    const before = await markers();
    // Ada under alpha, naming bravo's conversation and bravo's people.
    const upTo = new Date().toISOString();
    for (const [name, body] of [
      ['chat.messages', { conversationId: bravoConversation }],
      ['chat.mark_read', { conversationId: bravoConversation, upTo }],
      ['chat.send_direct', { teammateId: world.bea.personId, body: 'across' }],
    ] as const) {
      const answer = await chat.as(world.ada, name, body);
      expect(answer.code, `${name} ${answer.text}`).toBe('NOT_FOUND');
      clean(answer, name);
    }
    const listed = await chat.as(world.ada, 'chat.conversations');
    expect(
      (listed.body['conversations'] as readonly Body[]).map((c) => c['conversationId']),
    ).toEqual([alphaConversation]);
    expect(listed.text).not.toContain(bravoCanary);
    // Bea, a bravo member, asking under alpha: no membership here.
    for (const name of ['chat.conversations', 'chat.messages'] as const) {
      const answer = await chat.as(world.bea, name, { conversationId: alphaConversation }, 'alpha');
      expect(answer.status, name).toBe(403);
      clean(answer, name);
    }
    expect(await markers()).toBe(before);
    expect(await chat.holding('across')).toEqual([]);
  });

  it('C71-D isolation: another client of the business, each holding one grant, reads, lists, counts and changes nothing', async () => {
    const before = await markers();
    const upTo = new Date().toISOString();
    for (const client of chat.harness.clients) {
      const as = { token: client.token };
      for (const [name, body] of [
        ['chat.conversations', {}],
        ['chat.messages', { conversationId: alphaConversation }],
        ['chat.messages', { conversationId: bravoConversation }],
        ['chat.mark_read', { conversationId: alphaConversation, upTo }],
        ['chat.send_direct', { teammateId: chat.harness.world.ada.personId, body: 'client' }],
      ] as const) {
        const answer = await chat.as(as, name, body, client.businessKey);
        expect(answer.body['refused'], `${client.name} ${name} ${answer.text}`).toBe(true);
        clean(answer, `${client.name} ${name}`);
      }
    }
    expect(await markers()).toBe(before);
  });

  it('C71-D isolation: another person of the business, holding chat:comment, never reads, lists, counts or changes the pair’s conversation', async () => {
    const before = await markers();
    const { tess } = chat;
    const listed = await chat.as(tess, 'chat.conversations');
    expect(listed.body['conversations']).toEqual([]);
    for (const [name, body] of [
      ['chat.messages', { conversationId: alphaConversation }],
      ['chat.mark_read', { conversationId: alphaConversation, upTo: new Date().toISOString() }],
    ] as const) {
      const answer = await chat.as(tess, name, body);
      expect(answer.code, name).toBe('NOT_FOUND');
      clean(answer, name);
    }
    expect(await markers()).toBe(before);
  });

  it('C71-D isolation: an agent under a live delegation reads, lists and writes nothing', async () => {
    const before = await markers();
    const credential = await chat.agentCredential();
    for (const [name, body] of [
      ['chat.conversations', {}],
      ['chat.messages', { conversationId: alphaConversation }],
      ['chat.send_direct', { teammateId: chat.harness.world.mia.personId, body: 'agent' }],
    ] as const) {
      const answer = await chat.harness.asAgent(name, body, credential);
      expect(answer.body['refused'], `${name} ${answer.text}`).toBe(true);
      clean(answer, name);
    }
    expect(await markers()).toBe(before);
  });
});
