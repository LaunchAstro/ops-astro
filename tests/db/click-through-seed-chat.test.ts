// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: the click-through seed's one agent conversation. Ada asks the agent a
// made-up question and its reply is kept, so the side panel opens on a
// question and an answer. Only Ada reads it, it names no client, a second run
// leaves it alone, and one left without its reply is refused before anything
// is written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  ada,
  businessOf,
  closeWorld,
  guardState,
  openCast,
  openWorld,
  person,
  runSeed,
  SEED,
  serverUrl,
  snapshot,
  type Cast,
  type World,
} from './click-through-seed.fixture.ts';

const TITLE = 'Newsletter ideas';
const QUESTION = 'What are three ideas for a short team newsletter this month?';
const REPLY =
  'Three ideas: a welcome to anyone new on the team, a photo from the last team day, ' +
  'and one tip for keeping the shared drive tidy.';

let world: World;
let stranded: Cast | undefined;

interface Read {
  readonly conversation: { readonly id: string; readonly scope: { readonly id: string } | null };
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly body: string;
  }[];
}

const read = (cast: Cast, who: VerifiedSubject, request: object, business?: string) =>
  executeRead(cast.db.app, (business ?? cast.business) as BusinessId, who, request as never);

/** Ada's conversations as the panel's tab row lists them. */
async function tabsOf(who: VerifiedSubject): Promise<readonly { id: string; title: string }[]> {
  const listed = await read(world, who, { read: 'conversation.list' });
  if (isCommandRefusal(listed)) throw new Error(`conversation.list ${JSON.stringify(listed)}`);
  return (listed as unknown as { conversations: { id: string; title: string }[] }).conversations;
}

async function adaReads(id: string): Promise<Read> {
  const got = await read(world, ada(world), { read: 'conversation.read', conversationId: id });
  if (isCommandRefusal(got)) throw new Error(`conversation.read ${JSON.stringify(got)}`);
  return got as unknown as Read;
}

describe.skipIf(serverUrl === undefined)('SR-1 click-through seed conversation', () => {
  beforeAll(async () => {
    world = await openWorld();
  }, 600_000);

  afterAll(async () => {
    await closeWorld(world);
    await closeWorld(stranded);
  });

  readCases();
  crossingCases();
  strandedCase();
});

function readCases() {
  it("shows Ada one conversation, her question then the agent's reply to it", async () => {
    expect(world.first.status, world.first.out).toBe(0);
    const tabs = await tabsOf(ada(world));
    expect(tabs.map((tab) => tab.title)).toEqual([TITLE]);
    const { messages } = await adaReads(tabs[0]!.id);
    expect(messages.map((m) => [m.role, m.body])).toEqual([
      ['person', QUESTION],
      ['agent', REPLY],
    ]);
    const [reply] = await world.db.admin.execute<{ answers: string; author: string; ada: string }>(
      `select m.answers_message_id as answers, m.author_actor_id as author, c.owner_actor_id as ada
         from public.conversation_messages m join public.conversations c on c.id = m.conversation_id
        where m.id = $1`,
      [messages[1]!.id],
    );
    expect(reply).toEqual({ answers: messages[0]!.id, author: reply!.ada, ada: reply!.ada });
  });

  it('a second seed run leaves the conversation and its messages as they were', () => {
    expect(world.second.status, world.second.out).toBe(0);
    expect(world.second.out).toContain('already seeded, nothing made');
    for (const table of ['public.conversations', 'public.conversation_messages']) {
      expect(world.before[table], table).toHaveLength(table.endsWith('messages') ? 2 : 1);
      expect(world.after[table], table).toEqual(world.before[table]);
    }
  });
}

function crossingCases() {
  it("lets neither Mia nor bravo's Bea read Ada's conversation by its id", async () => {
    const [tab] = await tabsOf(ada(world));
    const id = tab!.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    const mia = person(world, 'mia@alpha.local');
    const bea = person(world, 'bea@bravo.local');
    const bravo = await businessOf(world.db, 'bravo');
    const answers = [
      await read(world, mia, { read: 'conversation.read', conversationId: id }),
      await read(world, bea, { read: 'conversation.read', conversationId: id }, bravo),
      await read(world, bea, { read: 'conversation.read', conversationId: id }),
    ];
    for (const answer of answers) {
      expect(isCommandRefusal(answer), JSON.stringify(answer)).toBe(true);
      for (const words of [TITLE, QUESTION, REPLY])
        expect(JSON.stringify(answer)).not.toContain(words);
    }
    // Mia holds no conversation grant: her tab row is refused or empty, never Ada's.
    const listed = await read(world, mia, { read: 'conversation.list' });
    expect(JSON.stringify(listed)).not.toContain(id);
  });

  it('names no client: no scope, or a task without one', async () => {
    const [tab] = await tabsOf(ada(world));
    const { conversation } = await adaReads(tab!.id);
    if (conversation.scope === null) return;
    const [task] = await world.db.admin.execute<{ client: string | null }>(
      'select uuid_7 as client from public.records where id = $1',
      [conversation.scope.id],
    );
    expect(task).toEqual({ client: null });
  });
}

function strandedCase() {
  it('refuses a conversation left without its reply, naming it, and writes nothing', async () => {
    stranded = await openCast('sr1clickchat');
    const asked = await executeCommand(stranded.db.app, stranded.business, ada(stranded), 'api', {
      command: 'conversation.start',
      operationId: `made-up:${randomUUID()}`,
      title: TITLE,
      body: QUESTION,
    } as never);
    expect('code' in asked, JSON.stringify(asked)).toBe(false);
    const was = [await snapshot(stranded.db), await guardState(stranded.db)];
    const ran = runSeed(SEED, { admin: stranded.db, local: stranded.local });
    expect(ran.status, ran.out).toBe(1);
    expect(ran.out).toMatch(/click-through-seed: REFUSED, 'Newsletter ideas' .*reset/u);
    expect([await snapshot(stranded.db), await guardState(stranded.db)]).toEqual(was);
  }, 300_000);
}
