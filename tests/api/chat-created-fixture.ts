// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666's world: the server's composition root over a fresh Postgres, with
// two stand-in models on loopback (each its own exchange, as two servers run
// them), the first answering through the API unless `quiet` is set, and the
// drawer's own writes for a card's click.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { ConversationExchange } from '../../packages/core-commands/src/commands/conversation-exchange.ts';
import type { ModelAnswer } from '../../packages/core-connectors/src/index.ts';
import { proposalCreate, readProposal } from '../../packages/core-wire/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  CONVERSATION,
  conversationWorld,
  detail,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from './aw-03-exchange-fixture.ts';
import { createApiFixture, type Answer, type ApiFixture } from './fixture.ts';

export const block = (json: string): string =>
  `Here is a task for that.\n\n\`\`\`task\n${json}\n\`\`\``;

export interface Reply {
  readonly messageId: string;
  readonly body: string;
  readonly targets?: unknown;
}

export const replyOf = (answer: Answer): Reply =>
  (answer.body as Record<string, unknown>)['reply'] as Reply;

/** The fields of the last request a stand-in saw, and its whole body. */
export function lastSeen(on: LocalModel): {
  readonly body: string;
  readonly fields: Record<string, string>;
} {
  const body = on.provider.seen.at(-1)?.body ?? '{}';
  return { body, fields: (JSON.parse(body) as { fields: Record<string, string> }).fields };
}

export interface ChatWorld {
  readonly fixture: ApiFixture;
  readonly w: ConversationWorld;
  readonly model: LocalModel;
  readonly other: LocalModel;
  readonly state: {
    /** What the stand-ins answer next. */
    says: string;
    /** While set, a kept question is not answered, so a case asks the exchanges itself. */
    quiet: boolean;
  };
  readonly revisionOf: (id: string) => Promise<number>;
  /** A new chat on no task, as `who`, its first reply proposing a create, clicked. */
  readonly created: (
    who: Member,
    title: string,
  ) => Promise<{ readonly conversationId: string; readonly task: string }>;
  /** The create card's click, as the drawer sends it. */
  readonly click: (who: Member, conversationId: string, reply: Reply) => Promise<string>;
  readonly say: (
    who: Member,
    conversationId: string,
    body: string,
    operationId?: string,
  ) => Promise<{ readonly reply: Reply; readonly messageId: string }>;
  /** A member with their own conversations and business-wide task write and read, and those grants' ids. */
  readonly member: (
    name: string,
  ) => Promise<{ readonly who: Member; readonly read: string; readonly write: string }>;
  readonly close: () => Promise<void>;
}

// eslint-disable-next-line max-lines-per-function -- one world: its stand-ins, its gate and its helpers
export async function chatWorld(name: string): Promise<ChatWorld> {
  const fixture = await createApiFixture(name);
  const state = { says: '', quiet: false };
  const answer = (): ModelAnswer => ({
    text: state.says,
    model: 'replay-1',
    usage: { inputUnits: 1, outputUnits: 1 },
    providerCode: null,
  });
  const model = await localModel(() => answer());
  const other = await localModel(() => answer());
  const gated: ConversationExchange = async (...args) =>
    state.quiet ? null : await model.exchange(...args);
  const w = await conversationWorld({ fixture, api: composedWith(fixture, gated) });
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    await grantTo(tx, w.owner, 'share');
  });
  const click = async (who: Member, conversationId: string, reply: Reply): Promise<string> => {
    const proposal = readProposal(reply.body).proposal;
    if (proposal === null) throw new Error('no create proposed');
    const write = proposalCreate(proposal, reply.messageId, conversationId);
    const made = await w.as(who, 'task.create', { ...write.body, operationId: write.operationId });
    expect(made.status).toBe(200);
    return String(made.body['recordId']);
  };
  return {
    fixture,
    w,
    model,
    other,
    state,
    revisionOf: async (id) =>
      await w.count(`select revision as n from public.records where id = $1`, [id]),
    created: async (who, title) => {
      state.says = block(
        JSON.stringify({ action: 'create', title, description: 'From the chat.' }),
      );
      const opened = await w.as(who, 'conversation.start', { body: `We need ${title}` });
      const conversationId = String(detail(opened)['conversationId']);
      return { conversationId, task: await click(who, conversationId, replyOf(opened)) };
    },
    click,
    say: async (who, conversationId, body, operationId = randomUUID()) => {
      const sent = await w.as(who, 'conversation.message', { operationId, conversationId, body });
      expect(sent.status).toBe(200);
      return { reply: replyOf(sent), messageId: String(detail(sent)['messageId']) };
    },
    member: async (label) => {
      const { db, business } = fixture;
      const who = await enrol(db.app, business, `${label}-${randomUUID().slice(0, 8)}`);
      return await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, who, 'write', undefined, false, CONVERSATION);
        const write = await grantTo(tx, who, 'write');
        return { who, write, read: await grantTo(tx, who, 'read') };
      });
    },
    close: async () => {
      await model.close();
      await other.close();
      await fixture.drop();
    },
  };
}
