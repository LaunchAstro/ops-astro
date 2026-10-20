// SPDX-License-Identifier: AGPL-3.0-only
//
// #1483: a conversation's earlier messages are its owner's alone. `contextOf`
// refuses any session that does not own the conversation before it reads
// anything, whoever calls it: a colleague in the same business, and a person
// of another business asking with the same ids, each get the refusal and none
// of the owner's words.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { contextOf } from '../../packages/core-commands/src/commands/conversation-context.ts';
import { withSession, type BusinessId } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail } from './aw-03-fixture.ts';
import { epochWorld, ownerOn, type EpochWorld } from './conversation-epoch-fixture.ts';
import { enrol, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';

/** The refusal that names nothing: no fields, cites, authors or created tasks (#1666). */
const REFUSED = {
  refused: true,
  fields: [],
  cites: [],
  authors: [],
  created: { snapshot: null, cut: null, sources: [] },
};

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  "a colleague in the same business is refused the owner's earlier messages",
  async () => {
    const c = await epochWorld('sol1401_owner');
    try {
      const canary = `private-owner-question-${randomUUID()}`;
      const opened = await c.w.as(c.w.owner, 'conversation.start', { body: canary });
      expect(opened.body['reply']).toMatchObject({ answered: true });
      const conversationId = String(detail(opened)['conversationId']);
      const body = 'pending question';
      const pending = await ownerOn(c, c.unanswered, 'conversation.message', {
        operationId: randomUUID(),
        conversationId,
        body,
      });
      const messageId = String(detail(pending)['messageId']);
      const asked = { conversationId, messageId };

      expect(
        await c.model.exchange(
          c.fixture.db.app,
          c.fixture.business,
          c.w.colleague.presented,
          asked,
        ),
      ).toBeNull();

      const ownerContext = await withSession(
        c.fixture.db.app,
        c.fixture.business,
        c.w.owner.presented,
        async (tx, session) => await contextOf(tx, session, { ...asked, body }, null),
      );
      expect(JSON.stringify(ownerContext)).toContain(canary);

      const colleagueContext = await withSession(
        c.fixture.db.app,
        c.fixture.business,
        c.w.colleague.presented,
        async (tx, session) => await contextOf(tx, session, { ...asked, body }, null),
      );
      expect(JSON.stringify(colleagueContext)).not.toContain(canary);
    } finally {
      await c.drop();
    }
  },
  180_000,
);

/** The owner's answered question, then a pending one: what `contextOf` is asked about. */
async function ownersPending(c: EpochWorld, canary: string) {
  const opened = await c.w.as(c.w.owner, 'conversation.start', { body: canary });
  expect(opened.body['reply']).toMatchObject({ answered: true });
  const conversationId = String(detail(opened)['conversationId']);
  const body = 'pending question';
  const pending = await ownerOn(c, c.unanswered, 'conversation.message', {
    operationId: randomUUID(),
    conversationId,
    body,
  });
  return { conversationId, messageId: String(detail(pending)['messageId']), body };
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  "a person of another business asking with the owner's ids is refused and reads nothing",
  async () => {
    const c = await epochWorld('ctx1483_bravo');
    try {
      const canary = `private-owner-question-${randomUUID()}`;
      const asked = await ownersPending(c, canary);
      const bravo = await insertBusiness(c.fixture.db.app, `bravo-${randomUUID().slice(0, 8)}`);
      await installSpine(c.fixture.db.app, bravo);
      const outsider = await enrol(c.fixture.db.app, bravo, 'bravo-person');
      const context = await withSession(
        c.fixture.db.app,
        bravo as BusinessId,
        outsider.presented,
        async (tx, session) => await contextOf(tx, session, asked, null),
      );
      expect(context).toMatchObject({ refused: true, fields: [], cites: [], authors: [] });
      expect(JSON.stringify(context)).not.toContain(canary);
    } finally {
      await c.drop();
    }
  },
  180_000,
);

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  "the colleague's refusal names nothing and the owner's own context is unchanged",
  async () => {
    const c = await epochWorld('ctx1483_refusal');
    try {
      const canary = `private-owner-question-${randomUUID()}`;
      const asked = await ownersPending(c, canary);
      const colleague = await withSession(
        c.fixture.db.app,
        c.fixture.business,
        c.w.colleague.presented,
        async (tx, session) => await contextOf(tx, session, asked, null),
      );
      expect(colleague).toEqual(REFUSED);
      const owner = await withSession(
        c.fixture.db.app,
        c.fixture.business,
        c.w.owner.presented,
        async (tx, session) => await contextOf(tx, session, asked, null),
      );
      expect(owner).toMatchObject({ refused: false, authors: [c.w.owner.actorId] });
    } finally {
      await c.drop();
    }
  },
  180_000,
);
