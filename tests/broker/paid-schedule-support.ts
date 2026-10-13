// SPDX-License-Identifier: AGPL-3.0-only
//
// What the paid chat's schedule cases share: waiting on what the server
// reports (a backend waiting on a lock, a backend parked in a transaction),
// never on a sleep, and a custody whose dispatch runs a case's step before it
// sends and once the send is admitted.

import { setTimeout as delay } from 'node:timers/promises';
import type { Admit, Custody } from '../../packages/core-custody/src/custody.ts';
import type { PricedWorld } from './priced-chat-world.ts';

/** Polls `look` until it answers true, one look at a time; throws with `what` if it never does. */
export async function until(look: () => Promise<boolean>, what: string): Promise<void> {
  for (let tries = 0; tries < 1_000; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls the server
    if (await look()) return;
    // oxlint-disable-next-line no-await-in-loop -- polls the server
    await delay(10);
  }
  throw new Error(`never: ${what}`);
}

/** Waits until a backend of this database waits on a lock while running a statement like `pattern`. */
export async function lockWaiter(p: PricedWorld, pattern: string): Promise<void> {
  await until(
    async () =>
      (await p.w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like $1`,
        [pattern],
      )) > 0,
    `a backend waited on a lock at ${pattern}`,
  );
}

/** The backends parked in an open transaction whose last statement was like `pattern`. */
export async function parkedAt(p: PricedWorld, pattern: string): Promise<readonly number[]> {
  const rows = await p.w.fixture.db.admin.execute<{ readonly pid: number }>(
    `select pid from pg_stat_activity
      where datname = current_database() and state = 'idle in transaction' and query like $1`,
    [pattern],
  );
  return rows.map((row) => row.pid);
}

/** Custody whose dispatch runs `before` first, and `admitted` once a send is admitted, before it goes. */
export const steppedCustody =
  (
    before: () => Promise<void>,
    admitted: () => Promise<void> = async () => await Promise.resolve(),
  ) =>
  (broker: PricedWorld['broker']): PricedWorld['broker'] => {
    const custody: Custody = broker.custody;
    const wrapAdmit = (admit: Admit | undefined): Admit | undefined =>
      admit === undefined
        ? undefined
        : async (sent) => {
            const ok = await admit(sent);
            if (ok) await admitted();
            return ok;
          };
    return {
      ...broker,
      custody: {
        ...custody,
        dispatch: async (ref, request, onPiece, admit) => {
          await before();
          return await custody.dispatch(ref, request, onPiece, wrapAdmit(admit));
        },
      },
    };
  };

/** The conversation's replies, as kept. */
export async function repliesOf(
  p: PricedWorld,
  conversationId: string,
): Promise<readonly { readonly body: string; readonly answers: string }[]> {
  return await p.w.fixture.db.admin.execute(
    `select body, answers_message_id::text as answers from public.conversation_messages
      where conversation_id = $1 and role = 'agent' order by created_at`,
    [conversationId],
  );
}
