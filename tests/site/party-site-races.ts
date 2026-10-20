// SPDX-License-Identifier: AGPL-3.0-only
//
// The party-site store's races, shared: a fresh client of the C80 world with a
// task under it and a site of two pages, a write held open on a connection of
// its own until the test lets it go, and the lock wait that proves one side
// stood behind the other, read from pg_stat_activity by the statement waiting.

import { randomUUID } from 'node:crypto';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect, insertLiveCorrection } from '../../packages/core-records/src/index.ts';
import {
  bindPartySite,
  readPartySite,
  type PartySiteRecord,
  type SiteWrite,
} from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import type { C80World } from './c80-world.ts';

export interface Page {
  readonly pageUrl: string;
  readonly path: string;
}

export interface FreshClient {
  readonly partyId: string;
  readonly taskId: string;
  /** Two pages of the client's site, each from its own file. */
  readonly pages: readonly [Page, Page];
  readonly site: PartySiteRecord;
}

/** A client of alpha's with a task under it and a site of two pages, its own. */
export async function freshClient(w: C80World): Promise<FreshClient> {
  const own = randomUUID().slice(0, 8);
  const partyId = randomUUID();
  await w.world.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2::uuid, $3, $4::uuid)`,
    [w.world.business, partyId, `client ${own}`, w.admin.actorId],
  );
  const created = await w.as(w.ava, { command: 'task.create', fields: { title: own } });
  if (isCommandRefusal(created)) throw new Error(`task.create refused ${created.code}`);
  const set = await w.as(w.admin, {
    command: 'task.set_party',
    recordId: created.recordId,
    expectedRevision: created.revision,
    fields: { client: partyId },
  });
  if (isCommandRefusal(set)) throw new Error(`task.set_party refused ${set.code}`);
  const page = (n: string): Page => ({
    pageUrl: `https://${own}.example/${n}/`,
    path: `src/pages/${n}-${own}.md`,
  });
  const pages: [Page, Page] = [page('one'), page('two')];
  const site = {
    partyId,
    repository: `race/${own}`,
    defaultBranch: 'main',
    project: `prj_race_${own}`,
    pages,
  };
  const bound = await inAlpha(w, async (tx) => await bindPartySite(tx, site, w.admin.actorId));
  if (!bound.ok) throw new Error(`freshClient: bind refused ${bound.code}`);
  return { partyId, taskId: String(created.recordId), pages, site };
}

/** `work` in a transaction of alpha's on the shared pool. */
export const inAlpha = async <T>(
  w: C80World,
  work: (tx: TransactionQuery) => Promise<T>,
): Promise<T> => await w.world.db.app.withBusiness(w.world.business, work);

/**
 * `work` in a transaction of alpha's on a connection of its own: the shared
 * pool may be busy with the very command the work races.
 */
export async function onOwn<T>(
  w: C80World,
  work: (tx: TransactionQuery) => Promise<T>,
): Promise<T> {
  const own = connect(w.world.db.appUrl, { source: 'runtime' });
  try {
    return await own.withBusiness(w.world.business, work);
  } finally {
    await own.close();
  }
}

/** The client's providers moved to a fresh default branch: the store's answer. */
export const moveOf =
  (w: C80World, partyId: string) =>
  async (tx: TransactionQuery): Promise<SiteWrite> => {
    const site = await readPartySite(tx, partyId);
    if (site === undefined) throw new Error('no site to move');
    const defaultBranch = `release-${randomUUID().slice(0, 6)}`;
    return await bindPartySite(tx, { ...site, defaultBranch }, w.admin.actorId);
  };

type Asked = Parameters<typeof insertLiveCorrection>[1];
type Stored = ReturnType<typeof insertLiveCorrection>;

/** A request on the client's task for one page, as the record layer stores it. */
export const askedOn = (w: C80World, client: FreshClient, page: Page): Asked => ({
  taskId: client.taskId,
  requestedByActorId: w.ava.actorId,
  requestedByPersonId: w.ava.personId,
  delegationId: null,
  word: 'friendly',
  replacement: 'welcoming',
  page: page.pageUrl,
  seam: `seam-${randomUUID()}`,
});

/** The record layer's insert of that request, for a held transaction. */
export const insertOn =
  (w: C80World, client: FreshClient, page: Page) =>
  async (tx: TransactionQuery): Stored =>
    await insertLiveCorrection(tx, askedOn(w, client, page));

export interface Held<T> {
  /** Settles once `work` has run and its locks are held. */
  readonly ready: Promise<T>;
  /** Let the transaction commit, or roll back with `rollback`. */
  release(rollback?: boolean): void;
  /** The transaction's end: `work`'s answer, or `'rolled back'`. */
  readonly done: Promise<T | 'rolled back'>;
}

const ROLLED_BACK = 'held: rolled back by the test';

/** `work` in a transaction of alpha's on a connection of its own, held open after it ran. */
export function held<T>(w: C80World, work: (tx: TransactionQuery) => Promise<T>): Held<T> {
  const second = connect(w.world.db.appUrl, { source: 'runtime' });
  let ran!: (value: T) => void;
  let failed!: (error: unknown) => void;
  let release!: (rollback: boolean) => void;
  const ready = new Promise<T>((resolve, reject) => {
    ran = resolve;
    failed = reject;
  });
  const released = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const transaction = second.withBusiness(w.world.business, async (tx) => {
    const answer = await work(tx).catch((error: unknown) => {
      failed(error);
      throw error;
    });
    ran(answer);
    if (await released) throw new Error(ROLLED_BACK);
    return answer;
  });
  const done = transaction
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === ROLLED_BACK) return 'rolled back' as const;
      throw error;
    })
    .finally(async () => {
      await second.close();
    });
  return { ready, release: (rollback = false) => release(rollback), done };
}

/** The statements of this database now waiting on a heavyweight lock. */
export async function lockWaiters(w: C80World): Promise<readonly string[]> {
  const rows = await w.world.db.admin.execute<{ readonly query: string }>(
    `select query from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
    [],
  );
  return rows.map((row) => row.query);
}

/** Until a statement matching `statement` waits on a lock; throws when none does. */
export async function waitSeen(w: C80World, statement: RegExp): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    if ((await lockWaiters(w)).some((query) => statement.test(query))) return;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`nothing waited: no ${String(statement)} stood behind a lock`);
}

/** Whether a statement matching `statement` came to wait on a lock. */
export const seenWaiting = async (w: C80World, statement: RegExp): Promise<boolean> =>
  await waitSeen(w, statement).then(
    () => true,
    () => false,
  );

/**
 * The statements each side runs, as pg_stat_activity shows them. An unbind
 * waits at its site row, or at its page's delete behind it.
 */
export const UNBIND: RegExp =
  /delete from public\.party_site_pages|from public\.party_sites\s+where business_id = \$1 and holder = coalesce\(\$2::uuid, \$1\)\s+for no key update/u;
export const BIND: RegExp = /insert into public\.party_sites/u;
export const PAGE_BIND: RegExp = /insert into public\.party_site_pages/u;
/** A request waits at its client's site row, or at its insert behind it. */
export const REQUEST: RegExp =
  /insert into public\.live_corrections|from public\.party_sites\s+where business_id = \$1 and holder = coalesce\(\$2::uuid, \$1\)\s+for share/u;
export const APPROVER: RegExp = /from public\.business_settings/u;

/** Whether a request's answer is a stored correction. */
export const isStored = (answer: unknown): boolean =>
  typeof answer === 'object' && answer !== null && 'id' in answer;

/** How many corrections the client has, in any state. */
export async function correctionsOf(w: C80World, partyId: string): Promise<number> {
  const [row] = await w.world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.live_corrections where party_id = $1',
    [partyId],
  );
  return Number(row?.n);
}
