// SPDX-License-Identifier: AGPL-3.0-only
//
// What the AW-07b timing and client cap cases add to the email world: a
// clean inbox per case, the clock moved by ageing the attempts already
// recorded, comments written by a person or by an agent, and a made-up
// per-category choice standing in for MP-2-11's setting (mock).

import { randomBytes } from 'node:crypto';
import { beforeAll } from 'vitest';
import type {
  EmailChoice,
  EmailPreferences,
  EmailTiming,
} from '../../packages/core-custody/src/index.ts';
import { writeComment, type InboxReason } from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { insertActor, insertAgentActor, insertPerson } from '../identity/fixture.ts';
import { MAIL, w } from './email-world.ts';

export const extra = {} as {
  commentType: string;
  personAuthor: string;
  agentAuthor: string;
  /** A second client's person in the first business: read on `otherTask` only. */
  clientB: string;
};

/** The choices a case sets; anything unset is the daily batch. Mock: MP-2-11 is not built here. */
export const choices: Map<string, EmailChoice> = new Map<string, EmailChoice>();

export const preferences: EmailPreferences = {
  mock: true,
  choice: async (_tx, personId, reason: InboxReason) =>
    await Promise.resolve(choices.get(`${personId}/${reason}`) ?? 'daily_batch'),
};

export const timing = (): EmailTiming => ({ broker: w.broker, mail: MAIL, preferences });

/** Withdraw every open item and push every attempt a week back: each case starts clean. */
export async function freshInbox(): Promise<void> {
  choices.clear();
  w.provider.mode('accept');
  await w.db.admin.execute(
    `update public.inbox_items set work_state = 'withdrawn', closed_at = now()
      where work_state = 'open'`,
  );
  await aged('8 days');
}

/** Move the clock: every attempt recorded so far is this much older. */
export async function aged(interval: string): Promise<void> {
  await w.db.admin.execute(
    `update public.inbox_delivery_attempts set observed_at = observed_at - $1::interval`,
    [interval],
  );
}

/** A client-visible comment on a task, by a person or by an agent. */
export async function commentBy(task: string, author: 'person' | 'agent'): Promise<string> {
  return await w.db.app.withBusiness(
    w.alpha,
    async (tx) =>
      await writeComment(tx, extra.commentType, {
        taskId: task,
        authorActorId: author === 'person' ? extra.personAuthor : extra.agentAuthor,
        commentType: 'client',
        audience: 'client',
        body: 'see the draft',
        source: 'app',
      }),
  );
}

export async function seenCount(items: readonly string[]): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.inbox_attention where item_id = any($1::uuid[])',
    [items],
  );
  return Number(row?.n ?? '-1');
}

/** Register after `useEmailWorld()`, so it runs once the world stands. */
export function useTimingWorld(): void {
  beforeAll(async () => {
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      extra.commentType = (await installTaskSpine(tx)).taskCommentTypeId;
      const author = await insertPerson(tx, 'Staff author');
      extra.personAuthor = await insertActor(tx, author);
      extra.agentAuthor = await insertAgentActor(tx);
      extra.clientB = await insertPerson(tx, 'Client B person');
      const actor = await insertActor(tx, extra.clientB);
      const [task] = await tx.query<{ client: string }>(
        'select uuid_7 as client from public.records where business_id = $1 and id = $2',
        [tx.businessId, w.otherTask],
      );
      const granted = await issueGrant(tx, [], {
        subject: { kind: 'person', id: extra.clientB },
        scope: { kind: 'party', id: task?.client ?? '' },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: actor,
      });
      if (!granted.ok) throw new Error('timing world: the client B grant was refused');
      await tx.query(
        `insert into public.person_identifiers
           (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
         values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
        [tx.businessId, extra.clientB, `clientb${randomBytes(4).toString('hex')}@example.test`],
      );
    });
  }, 60_000);
}
