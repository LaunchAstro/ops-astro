// SPDX-License-Identifier: AGPL-3.0-only
//
// R7's world: AW-03's conversation world with its window at seven days, a
// second business in the same database, and what a case reads back: every
// failure the sweeper raised and every console line it wrote, so a case can
// look for a planted body in both.

import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { SweepFailure } from '../../apps/api/conversation-sweeper.ts';
import {
  sweepConversations,
  type SweepReport,
  type SweepRequest,
} from '../../packages/core-commands/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { enrol, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

export const REVISION = 'r7test';

export interface SweeperWorld {
  readonly w: ConversationWorld;
  readonly db: Database;
  readonly alpha: string;
  /** A second business in the same database, with a member of its own. */
  readonly bravo: { readonly id: string; readonly member: Member };
  readonly window: (businessId: string, days: number) => Promise<void>;
  /** A conversation in Alpha, eight days quiet: the next pass wraps it and the one after purges it. */
  readonly dueInAlpha: (body: string) => Promise<string>;
  /** The same in Bravo, written by its member through the app role. */
  readonly dueInBravo: (body: string) => Promise<string>;
  readonly messages: (conversationId: string) => Promise<number>;
  readonly wrapUps: (conversationId: string) => Promise<number>;
}

async function bravoBusiness(db: Database): Promise<SweeperWorld['bravo']> {
  const id = await insertBusiness(db, `r7-bravo-${randomUUID().slice(0, 8)}`);
  await installSpine(db, id);
  const member = await enrol(db, id, 'bravo-owner');
  await db.withBusiness(id, async (tx) => {
    await installBusinessSettings(tx);
    await setConversationWindow(tx, 7);
  });
  return { id, member };
}

/** A conversation and its first message, inserted as the owner's own, then aged. */
async function insertedConversation(
  w: ConversationWorld,
  businessId: string,
  member: Member,
  body: string,
): Promise<string> {
  const id = randomUUID();
  await w.fixture.db.app.withBusiness(businessId, async (tx) => {
    await tx.query(
      `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
       values ($1, $2, $3, $4, 'Bravo conversation')`,
      [businessId, id, member.actorId, member.personId],
    );
    await tx.query(
      `insert into public.conversation_messages
         (business_id, id, conversation_id, role, author_actor_id, body)
       values ($1, $2, $3, 'person', $4, $5)`,
      [businessId, randomUUID(), id, member.actorId, body],
    );
  });
  await w.age(id, 8);
  return id;
}

export async function sweeperWorld(part: string): Promise<SweeperWorld> {
  const w = await conversationWorld(part);
  const db = w.fixture.db.app;
  const alpha = w.fixture.business;
  const bravo = await bravoBusiness(db);
  const counter =
    (table: string) =>
    async (conversationId: string): Promise<number> =>
      await w.count(`select count(*) as n from public.${table} where conversation_id = $1`, [
        conversationId,
      ]);
  return {
    w,
    db,
    alpha,
    bravo,
    window: async (businessId, days) => {
      await db.withBusiness(businessId, async (tx) => {
        await setConversationWindow(tx, days);
      });
    },
    dueInAlpha: async (body) => {
      const id = await started(w, w.owner, { body });
      await w.age(id, 8);
      return id;
    },
    dueInBravo: async (body) => await insertedConversation(w, bravo.id, bravo.member, body),
    messages: counter('conversation_messages'),
    wrapUps: counter('conversation_wrap_ups'),
  };
}

/** A raise port that keeps what it is handed. */
export function raisedFailures(): {
  readonly failures: SweepFailure[];
  readonly raise: (failure: SweepFailure) => void;
} {
  const failures: SweepFailure[] = [];
  return { failures, raise: (failure) => void failures.push(failure) };
}

/** Every console line written until `restore`, joined for a search. */
export function consoleLines(): { readonly text: () => string; readonly restore: () => void } {
  const lines: string[] = [];
  const keep = (...parts: unknown[]): void => {
    lines.push(parts.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'log').mockImplementation(keep),
  ];
  return {
    text: () => lines.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** The real pass, with a gate a case opens: each call waits on it first and counts how many overlap. */
export function gatedSweep(): {
  readonly sweep: (database: Database, request: SweepRequest) => Promise<SweepReport>;
  readonly calls: string[];
  readonly widest: () => number;
  readonly open: () => void;
} {
  const calls: string[] = [];
  let running = 0;
  let widest = 0;
  const opened: { open?: () => void } = {};
  const gate = new Promise<void>((resolve) => {
    opened.open = resolve;
  });
  return {
    sweep: async (database, request) => {
      calls.push(request.businessId);
      running += 1;
      widest = Math.max(widest, running);
      try {
        await gate;
        return await sweepConversations(database, request);
      } finally {
        running -= 1;
      }
    },
    calls,
    widest: () => widest,
    open: () => {
      opened.open?.();
    },
  };
}

/** Wait `ms` on the clock. */
export async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
