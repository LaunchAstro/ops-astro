// SPDX-License-Identifier: AGPL-3.0-only
//
// C36 isolation: a conversation's address, resolved to its id as a pasted one
// is, read through the real boundary and a fresh Postgres by each crossing,
// statuses checked, with no body carrying the conversation's title, canary or
// id, refusals included: another business (the same login in Bravo, answered
// as a made-up address is); another client in the same business (read-any on
// client two's task opens nothing of a conversation scoped to client one's);
// another person under a live delegation (the owner's agent opens nothing).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { addressWorld, carriesNothing, conversationOf, type AddressWorld } from './c36-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('C36 isolation', () => {
  let x: AddressWorld;

  beforeAll(async () => {
    x = await addressWorld('c36_isolation');
  }, 180_000);

  afterAll(async () => await x?.c.drop());

  it('C36 isolation: the owner opens the address and reads the same conversation', async () => {
    expect(x.address).toBe(`/agent/${x.conversationId}`);
    const own = await x.w.as(x.w.owner, 'conversation.read', {
      conversationId: conversationOf(x.address),
    });
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(x.canary);
  });

  it('C36 isolation: another business opens nothing, answered exactly as a made-up address', async () => {
    const across = await x.inBravo(x.address);
    const madeUp = await x.inBravo(`/agent/${randomUUID()}`);
    expect(across.status).toBe(404);
    expect(across).toEqual(madeUp);
    expect(carriesNothing(x, across)).toBe(true);
  });

  it('C36 isolation: another client in the same business: read-any on client two opens nothing of client one’s', async () => {
    const answer = await x.w.as(x.readerOfTwo, 'conversation.read', {
      conversationId: conversationOf(x.address),
    });
    expect(answer.status).toBe(403);
    expect(carriesNothing(x, answer)).toBe(true);
  });

  it('C36 isolation: another person under a live delegation: the owner’s agent opens nothing', async () => {
    const agent = await x.c.asAgent(
      'conversation.read',
      { conversationId: conversationOf(x.address) },
      x.work.credential,
    );
    expect(agent.status).toBe(403);
    expect(agent.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(carriesNothing(x, agent)).toBe(true);
  });
});
