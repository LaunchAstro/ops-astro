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
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
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
let revoked: Cast | undefined;

/** The seed's chat part, untyped JavaScript, called as the seed calls it. */
const CHAT = new URL('../../scripts/ops/click-through-chat.mjs', import.meta.url).href;
const chatPart = async () => (await import(CHAT)) as { askTheAgent: (w: object) => Promise<void> };

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

/** A person's conversations as the panel's tab row lists them, in their business or `business`. */
async function tabsOf(
  who: VerifiedSubject,
  business?: string,
): Promise<readonly { id: string; title: string }[]> {
  const listed = await read(world, who, { read: 'conversation.list' }, business);
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
    await closeWorld(revoked);
  });

  readCases();
  crossingCases();
  strandedCase();
  revokedCase();
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
  // After the snapshot cases. Each reader holds a conversation grant of their
  // own, so each refusal is the rule under test, never a reader holding none:
  // Mia, given conversation:write by Ada, meets the owner rule; Bea, given
  // bravo's read-any grant (conversation:read), meets the business boundary.
  it("lets neither Mia, holding conversation:write, nor bravo's Bea, holding read-any, read Ada's conversation", async () => {
    const [tab] = await tabsOf(ada(world));
    const id = tab!.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    const mia = person(world, 'mia@alpha.local');
    const bea = person(world, 'bea@bravo.local');
    const bravo = await businessOf(world.db, 'bravo');
    await grantMia();
    await grantBea(bravo);
    // Both hold their grant: each lists their own tabs, and there are none.
    expect(await tabsOf(mia)).toEqual([]);
    expect(await tabsOf(bea, bravo)).toEqual([]);
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
    expect(JSON.stringify(answers[0])).toContain('its owner’s alone');
    expect(answers[1]).toMatchObject({ code: 'NOT_FOUND' });
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

function revokedCase() {
  // Sol PRV-oa-1093-R2: the reply is the seed's own write, so it asks what
  // keep() asks. Ada's sole conversation:write grant is revoked, and the
  // revocation committed, after her question and before the reply.
  it('keeps no reply once Ada loses conversation:write between her question and its reply', async () => {
    revoked = await openCast('sr1clickrevoke');
    const { w, asked } = await revokingWorld(revoked);
    const { askTheAgent } = await chatPart();
    const ran = await askTheAgent(w).then(() => 'kept', String);
    expect(ran).toMatch(/'Newsletter ideas'.*conversation:write/u);
    const [after] = await revoked.db.admin.execute<{ roles: string[]; moved: boolean }>(
      `select array_agg(m.role order by m.created_at) as roles,
              c.last_activity_at > min(m.created_at) as moved
         from public.conversations c
         join public.conversation_messages m on m.conversation_id = c.id
        where c.id = $1 group by c.id, c.last_activity_at`,
      [asked().conversationId],
    );
    expect(after).toEqual({ roles: ['person'], moved: false });
  }, 300_000);
}

/**
 * The seed's world for the chat part alone, as Ada, whose `as` revokes her
 * one conversation:write grant through the product once her question commits.
 */
async function revokingWorld(cast: Cast) {
  const [held] = await cast.db.admin.execute<{ actor: string; grant: string }>(
    `select a.id as actor, g.id as grant from public.people p
       join public.actors a on a.business_id = p.business_id and a.person_id = p.id
       join public.grants g on g.business_id = p.business_id and g.subject_kind = 'person'
        and g.subject_id = p.id and g.collection = 'conversation' and g.action = 'write'
      where p.business_id = $1 and p.display_name = 'Ada Alpha'`,
    [cast.business],
  );
  const command = (body: object) =>
    executeCommand(cast.db.app, cast.business, ada(cast), 'api', {
      operationId: `made-up:${randomUUID()}`,
      ...body,
    } as never);
  let asked: { conversationId: string; messageId: string } | undefined;
  const w = {
    admin: 'Ada Alpha',
    database: cast.db.app,
    cast: {
      businessId: cast.business,
      adminActorId: held!.actor,
      people: { 'Ada Alpha': ada(cast) },
    },
    as: async (_name: string, body: object) => {
      const started = await command(body);
      if (isCommandRefusal(started)) throw new Error(JSON.stringify(started));
      asked = started.detail as unknown as { conversationId: string; messageId: string };
      const gone = await command({ command: 'access.revoke', grantId: held!.grant });
      expect('code' in gone, JSON.stringify(gone)).toBe(false);
      return asked;
    },
  };
  return { w, asked: () => asked! };
}

/** Ada gives Mia conversation:write through the product. */
async function grantMia(): Promise<void> {
  const [held] = await world.db.admin.execute<{ id: string }>(
    `select id from public.people where business_id = $1 and display_name = 'Mia Alpha'`,
    [world.business],
  );
  const granted = await executeCommand(world.db.app, world.business, ada(world), 'api', {
    command: 'access.grant',
    operationId: `made-up:${randomUUID()}`,
    holderId: held!.id,
    collection: 'conversation',
    action: 'write',
  } as never);
  expect('code' in granted, JSON.stringify(granted)).toBe(false);
}

/** Bea gets bravo's conversation:write and read-any grants, as local-seed issues one: bravo has no administrator. */
async function grantBea(bravo: string): Promise<void> {
  const [bea] = await world.db.admin.execute<{ person: string; actor: string }>(
    `select p.id as person, a.id as actor from public.people p
       join public.actors a on a.business_id = p.business_id and a.person_id = p.id
      where p.business_id = $1 and p.display_name = 'Bea Bravo'`,
    [bravo],
  );
  // Write lists her own tab row; read-any would read any conversation of bravo.
  const issued = await world.db.app.withBusiness(bravo as BusinessId, async (tx) => [
    await issueGrant(tx, [], { ...BEA_GRANT(bea!), action: 'write' }),
    await issueGrant(tx, [], { ...BEA_GRANT(bea!), action: 'read' }),
  ]);
  expect(
    issued.map((one) => one.ok),
    JSON.stringify(issued),
  ).toEqual([true, true]);
}

const BEA_GRANT = (bea: { readonly person: string; readonly actor: string }) =>
  ({
    subject: { kind: 'person', id: bea.person },
    scope: { kind: 'business', id: null },
    collection: 'conversation',
    parentGrantId: null,
    grantedByActorId: bea.actor,
  }) as const;
