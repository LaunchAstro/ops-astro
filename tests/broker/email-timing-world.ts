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
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { insertActor, insertAgentActor, insertPerson } from '../identity/fixture.ts';
import { MAIL, w } from './email-world.ts';

export const extra = {} as {
  commentType: string;
  personAuthor: string;
  agentAuthor: string;
  /** A second client's person in the first business: read on `otherTask` only. */
  clientB: string;
  /** A second person of the first client: read on `task` only. */
  clientA2: string;
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

/** A client's person in the first business: read on that task's client, a confirmed address. */
async function clientPerson(tx: TenantQuery, name: string, task: string): Promise<string> {
  const person = await insertPerson(tx, name);
  const actor = await insertActor(tx, person);
  const [row] = await tx.query<{ client: string }>(
    'select uuid_7 as client from public.records where business_id = $1 and id = $2',
    [tx.businessId, task],
  );
  const granted = await issueGrant(tx, [], {
    subject: { kind: 'person', id: person },
    scope: { kind: 'party', id: row?.client ?? '' },
    collection: 'task',
    action: 'read',
    parentGrantId: null,
    grantedByActorId: actor,
  });
  if (!granted.ok) throw new Error('timing world: a client grant was refused');
  await tx.query(
    `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
    [tx.businessId, person, `client${randomBytes(4).toString('hex')}@example.test`],
  );
  return person;
}

/** Register after `useEmailWorld()`, so it runs once the world stands. */
export function useTimingWorld(): void {
  beforeAll(async () => {
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      extra.commentType = (await installTaskSpine(tx)).taskCommentTypeId;
      extra.personAuthor = await insertActor(tx, await insertPerson(tx, 'Staff author'));
      extra.agentAuthor = await insertAgentActor(tx);
      extra.clientB = await clientPerson(tx, 'Client B person', w.otherTask);
      extra.clientA2 = await clientPerson(tx, 'Second client A person', w.task);
    });
  }, 60_000);
}

/**
 * Another sender mid-send: `work` runs in its own transaction, which stays
 * open, its writes uncommitted and its locks held, until `release`.
 */
export async function heldOpen(
  work: (tx: TenantQuery) => Promise<unknown>,
): Promise<{ release: () => Promise<void> }> {
  let finish = (): void => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started = (): void => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = w.db.app.withBusiness(w.alpha, async (tx) => {
    await work(tx);
    started();
    await gate;
  });
  await ready;
  return {
    release: async () => {
      finish();
      await done;
    },
  };
}

/** Whether a promise is still pending after a short wait. */
export async function stillWaiting(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const timer = new Promise((resolve) => setTimeout(() => resolve(pending), 400));
  return (await Promise.race([promise, timer])) === pending;
}
