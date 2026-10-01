// SPDX-License-Identifier: AGPL-3.0-only
//
// C36: one world for a conversation's address, read through the real
// boundary and a fresh Postgres. The owner holds a conversation scoped to
// client one's task, with a canary in its title, subject and first message;
// its address is the one the product answers, resolved back to its id exactly as a
// pasted address is. Around it: a
// reader holding read-any on client two's task only; the same login as a
// member of another business, Bravo; the owner's agent under a live
// delegation; the colleague (no conversation grant beyond write).

import { randomUUID } from 'node:crypto';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import type { Controls } from './controls-fixture.ts';
import {
  CONVERSATION,
  conversationWorld,
  detail,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

export interface AddressWorld {
  readonly c: Controls;
  readonly w: ConversationWorld;
  readonly work: PickedUp;
  readonly canary: string;
  readonly title: string;
  readonly conversationId: string;
  /** The address the product answered for it: `/agent/<id>`. */
  readonly address: string;
  readonly taskOne: string;
  readonly readerOfTwo: Member;
  /** Reads an address in Bravo as the member both businesses share. */
  readonly inBravo: (address: string) => Promise<Answer>;
}

/**
 * The id an address carries: `/agent/<id>` exactly, nothing before or after.
 * The web's route registry resolves the same address to the screen that reads
 * by this id (`tests/surfaces/c36-conversation-address.test.tsx`); the root
 * typecheck cannot take the registry's inferred type, so the shape is spelt
 * here.
 */
export function conversationOf(address: string): string {
  const match = /^\/agent\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(
    address,
  );
  if (match?.[1] === undefined) throw new Error(`${address} is not a conversation's address`);
  return match[1];
}

async function bravoMember(w: ConversationWorld, both: Member): Promise<void> {
  const { db } = w.fixture;
  const bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, bravo);
  await db.app.withBusiness(bravo, async (tx) => {
    const { insertActor, insertLogin, insertMapping, insertMembership, insertPerson } =
      await import('../identity/fixture.ts');
    const personId = await insertPerson(tx, 'both-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, both.presented.subject);
    await insertMapping(tx, loginId, personId, actorId);
    const member = { personId, actorId, presented: both.presented };
    await grantTo(tx, member, 'write', undefined, false, CONVERSATION);
    await grantTo(tx, member, 'read', undefined, false, CONVERSATION);
  });
}

export async function addressWorld(name: string): Promise<AddressWorld> {
  const { c } = await checksWorld(name);
  const w = await conversationWorld(c);
  const work = await pickedUpOn(c, `${name}_crossing`);
  const taskOne = (await c.createTask('client one')).id;
  const taskTwo = (await c.createTask('client two')).id;
  const canary = `CANARY-${randomUUID()}`;
  const title = `Title-${canary}`;
  const conversationId = await started(w, w.owner, {
    scope: { kind: 'task', id: taskOne },
    title,
    subject: `Subject-${canary}`,
    body: `${canary} what did the supplier quote?`,
  });
  const said = await w.as(w.owner, 'conversation.message', {
    conversationId,
    body: 'And the terms?',
  });
  const address = String(detail(said)['address']);
  const { db, business } = w.fixture;
  const readerOfTwo = await enrol(db.app, business, 'reader-two');
  const both = await enrol(db.app, business, 'both');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, readerOfTwo, 'read', { kind: 'record', id: taskTwo }, false, CONVERSATION);
    await grantTo(tx, readerOfTwo, 'write', undefined, false, CONVERSATION);
    await grantTo(tx, w.owner, 'share');
  });
  await bravoMember(w, both);
  const token = authorised(await tokenFor(both.presented.subject));
  const inBravo = async (at: string): Promise<Answer> =>
    await post(
      w.api,
      '/api/b/bravo/conversation/read',
      { conversationId: conversationOf(at) },
      token,
    );
  return { c, w, work, canary, title, conversationId, address, taskOne, readerOfTwo, inBravo };
}

/** Nothing of the conversation in a body: title, canary or id. */
export function carriesNothing(world: AddressWorld, answer: { readonly body: unknown }): boolean {
  const text = JSON.stringify(answer.body);
  return [world.canary, world.title, world.conversationId].every((value) => !text.includes(value));
}
