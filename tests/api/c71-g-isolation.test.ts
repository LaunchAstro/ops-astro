// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G isolation (standing gate 9), over the real HTTP routes: two
// businesses, two clients in each with one grant each (a share of one task),
// and a group conversation with its own canary body in each business. Another
// business's group, or a group the caller is not in, is never read, listed,
// counted or changed, and a canary never appears in a foreign response.

// oxlint-disable no-await-in-loop -- one caller at a time, each read back
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';

type Body = Readonly<Record<string, unknown>>;
type Who = Parameters<ChatWorld['as']>[0];

/** Every group command, aimed at one conversation. */
const aimedAt = (conversationId: string, someone: unknown) =>
  [
    ['chat.messages', { conversationId }],
    ['chat.send_group', { conversationId, body: 'across' }],
    ['chat.mark_read', { conversationId, upTo: new Date().toISOString() }],
    ['chat.rename_group', { conversationId, name: 'across' }],
    ['chat.change_members', { conversationId, add: [someone] }],
    ['chat.leave', { conversationId }],
  ] as const;

// eslint-disable-next-line max-lines-per-function -- one world, the four crossings
describe.skipIf(databaseUrlFromEnvironment() === undefined)('C71-G isolation', () => {
  let chat: ChatWorld;

  // Red: the group commands are not on the surface yet, so their names are text here.
  type Loose = (who: Who, name: string, body?: Body, business?: string) => Promise<Answer>;
  type LooseAgent = (name: string, body: Body, credential?: string) => Promise<Answer>;
  const as: Loose = async (...args) => await (chat.as as Loose)(...args);
  const asAgent: LooseAgent = async (...args) =>
    await (chat.harness.asAgent as LooseAgent)(...args);
  const alphaCanary = `alpha-group-${randomUUID()}`;
  const bravoCanary = `bravo-group-${randomUUID()}`;
  let alphaGroup: string;
  let bravoGroup: string;
  let bex: Caller;

  /** Both businesses' groups and member rows, read past row security. */
  const state = async (): Promise<string> =>
    JSON.stringify(
      await chat.harness.world.db.admin.execute(
        `select m.conversation_id, m.person_id, m.joined_at, m.left_at, m.last_read_at, r.data
           from public.team_conversation_members m
           join public.records r on r.business_id = m.business_id and r.id = m.conversation_id
          order by 1, 2`,
      ),
    );
  const clean = (answer: Answer, label: string): void => {
    expect(answer.text, label).not.toContain(alphaCanary);
    expect(answer.text, label).not.toContain(bravoCanary);
  };
  const groupOf = (answer: Answer): string =>
    String((answer.body['detail'] as Body)['conversationId']);

  beforeAll(async () => {
    chat = await createChatWorld('c71giso');
    const { world } = chat.harness;
    bex = await enrolCaller(world.db, world.bravo, 'bravo', 'bex', {
      membership: true,
      actions: ['comment'],
      collections: ['chat'],
    });
    alphaGroup = groupOf(
      await as(world.ada, 'chat.start_group', {
        name: 'Alpha group',
        members: [world.mia.personId, chat.tess.personId],
      }),
    );
    await as(world.ada, 'chat.send_group', { conversationId: alphaGroup, body: alphaCanary });
    bravoGroup = groupOf(
      await as(
        world.bea,
        'chat.start_group',
        { name: 'Bravo group', members: [chat.bo.personId, bex.personId] },
        'bravo',
      ),
    );
    await as(
      world.bea,
      'chat.send_group',
      { conversationId: bravoGroup, body: bravoCanary },
      'bravo',
    );
  }, 180_000);

  afterAll(async () => {
    await chat?.harness.close();
  });

  it('C71-G isolation: another business’s group is never read, listed, counted or changed, and answers as one never issued', async () => {
    const { world } = chat.harness;
    expect(bravoGroup).not.toBe('undefined');
    const before = await state();
    for (const [name, body] of aimedAt(bravoGroup, world.mia.personId)) {
      const foreign = await as(world.ada, name, body);
      expect(foreign.code, `${name} ${foreign.text}`).toBe('NOT_FOUND');
      clean(foreign, name);
      const fabricated = await as(world.ada, name, { ...body, conversationId: randomUUID() });
      expect([foreign.status, foreign.text], name).toStrictEqual([
        fabricated.status,
        fabricated.text,
      ]);
    }
    // Bravo's people are not teammates here, in the same bytes as made-up ones.
    const start = async (members: readonly unknown[]) =>
      await as(world.ada, 'chat.start_group', { name: 'across', members });
    const foreign = await start([world.mia.personId, chat.bo.personId]);
    const fabricated = await start([world.mia.personId, randomUUID()]);
    expect(foreign.code).toBe('NOT_FOUND');
    expect([foreign.status, foreign.text]).toStrictEqual([fabricated.status, fabricated.text]);
    // Nor added to a group here.
    const added = await as(world.ada, 'chat.change_members', {
      conversationId: alphaGroup,
      add: [chat.bo.personId],
    });
    expect(added.code).toBe('NOT_FOUND');
    const listed = await as(world.ada, 'chat.conversations');
    expect(
      (listed.body['conversations'] as readonly Body[]).map((c) => c['conversationId']),
    ).toEqual([alphaGroup]);
    clean(listed, 'listed');
    // Bea, a bravo member, asking under alpha: no membership here.
    for (const [name, body] of aimedAt(alphaGroup, chat.bo.personId)) {
      const answer = await as(world.bea, name, body, 'alpha');
      expect(answer.status, name).toBe(403);
      clean(answer, name);
    }
    expect(await state()).toBe(before);
    expect(await chat.holding('across')).toEqual([]);
  });

  it('C71-G isolation: another client of the business, each holding one grant, reads, lists, counts and changes nothing', async () => {
    const before = await state();
    for (const client of chat.harness.clients) {
      const holder = { token: client.token };
      for (const [name, body] of [
        ['chat.conversations', {}],
        ['chat.start_group', { name: 'client', members: [randomUUID(), randomUUID()] }],
        ...aimedAt(alphaGroup, randomUUID()),
        ...aimedAt(bravoGroup, randomUUID()),
      ] as const) {
        const answer = await as(holder, name, body, client.businessKey);
        expect(answer.body['refused'], `${client.name} ${name} ${answer.text}`).toBe(true);
        clean(answer, `${client.name} ${name}`);
      }
    }
    expect(await state()).toBe(before);
  });

  it('C71-G isolation: another person of the business, an administrator holding chat:manage, never reads, lists, counts or changes a group they are not in', async () => {
    const { world } = chat.harness;
    const without = groupOf(
      await as(chat.tess, 'chat.start_group', {
        name: 'Without Ada',
        members: [world.mia.personId, world.noah.personId],
      }),
    );
    const before = await state();
    for (const [name, body] of aimedAt(without, chat.tess.personId)) {
      const answer = await as(world.ada, name, body);
      expect(answer.code, `${name} ${answer.text}`).toBe('NOT_FOUND');
      const fabricated = await as(world.ada, name, { ...body, conversationId: randomUUID() });
      expect([answer.status, answer.text], name).toStrictEqual([
        fabricated.status,
        fabricated.text,
      ]);
    }
    const listed = await as(world.ada, 'chat.conversations');
    expect(
      (listed.body['conversations'] as readonly Body[]).map((c) => c['conversationId']),
    ).toEqual([alphaGroup]);
    expect(await state()).toBe(before);
  });

  it('C71-G isolation: an agent under a live delegation reads, lists and writes nothing', async () => {
    const before = await state();
    const credential = await chat.agentCredential();
    for (const [name, body] of [
      ['chat.conversations', {}],
      [
        'chat.start_group',
        {
          name: 'agent',
          members: [chat.harness.world.mia.personId, chat.tess.personId],
        },
      ],
      ...aimedAt(alphaGroup, chat.tess.personId),
    ] as const) {
      const answer = await asAgent(name, body, credential);
      expect(answer.body['refused'], `${name} ${answer.text}`).toBe(true);
      clean(answer, name);
    }
    expect(await state()).toBe(before);
  });
});
