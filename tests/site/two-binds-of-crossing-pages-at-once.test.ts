// SPDX-License-Identifier: AGPL-3.0-only
//
// S2333-2 (#2316): two binds of two clients of one business, each on a
// connection of its own, naming the same two pages in crossing order. Each
// is paused after its first page's insert until the other reaches its own
// (or a short wait passes, when the other is standing behind a lock), so
// taken in that order the pair closes a cycle the server breaks with a
// deadlock (40P01).
//
// Through `client.bind_site`, one bind applies and the other is refused
// `PAGE_BOUND_ELSEWHERE`, never a fault. In the store, a deadlock victim's
// error stays the server's, so the envelope's retry knows it
// (`isRetryableViolation`).

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  isCommandRefusal,
  type CommandRefusal,
} from '../../packages/core-commands/src/commands/refusal.ts';
import { isRetryableViolation } from '../../packages/core-commands/src/commands/register-store.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import { c80World, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Crossing binds: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('crossing');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.admin, 'manage', WHOLE_BUSINESS, false, 'operations');
  });
});

/** A client of alpha's with no site yet. */
async function alphaClient(): Promise<string> {
  const id = randomUUID();
  await w.world.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2::uuid, $3, $4::uuid)`,
    [w.world.business, id, `crossing client ${id.slice(0, 8)}`, w.admin.actorId],
  );
  return id;
}

/** Two callers meet after their first page insert, or go on alone after `ms`. */
function meeting(ms = 1500): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const met = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === 2) open();
    await Promise.race([
      met,
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    ]);
  };
}

const PAGE_INSERT = /insert into public\.party_site_pages/u;

/** The transaction with `pause` run once, after its first page insert, savepoints included. */
function pausing(tx: TransactionQuery, pause: () => Promise<void>): TransactionQuery {
  let paused = false;
  const wrap = (inner: TransactionQuery): TransactionQuery =>
    new Proxy(inner, {
      get(target, key, receiver) {
        if (key === 'query') {
          return async (text: string, values?: readonly unknown[]) => {
            const rows = await target.query(text, values as unknown[]);
            if (!paused && PAGE_INSERT.test(text)) {
              paused = true;
              await pause();
            }
            return rows;
          };
        }
        if (key === 'savepoint') {
          return async (work: (each: TransactionQuery) => Promise<void>) =>
            await target.savepoint(async (each) => await work(wrap(each)));
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  return wrap(tx);
}

/** A database on its own connection whose transactions pause as `pausing` does. */
function pausedDatabase(pause: () => Promise<void>): Database {
  const own = connect(w.world.db.appUrl, { source: 'runtime' });
  return new Proxy(own, {
    get(target, key, receiver) {
      if (key === 'withBusiness') {
        return async <T>(id: string, run: (tx: TransactionQuery) => Promise<T>, options?: object) =>
          await target.withBusiness(id, async (tx) => await run(pausing(tx, pause)), options);
      }
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

interface Page {
  readonly pageUrl: string;
  readonly path: string;
}

const pagesOf = (own: string): readonly [Page, Page] => [
  { pageUrl: `https://${own}.example/one`, path: 'src/pages/one.astro' },
  { pageUrl: `https://${own}.example/two`, path: 'src/pages/two.astro' },
];

/** Each side's answer: applied, its refusal's code, or `fault <code or message>`. */
const outcomeOf = (answer: PromiseSettledResult<CommandRefusal | object>): string => {
  if (answer.status === 'rejected') {
    const reason = answer.reason as { readonly code?: unknown; readonly message?: unknown };
    return `fault ${String(reason.code ?? reason.message)}`;
  }
  return isCommandRefusal(answer.value) ? answer.value.code : 'applied';
};

async function crossingCommands(): Promise<void> {
  const own = randomUUID().slice(0, 8);
  const [one, two] = pagesOf(own);
  const pause = meeting();
  const bind = async (pages: readonly Page[], tag: string) => {
    const database = pausedDatabase(pause);
    try {
      return await executeCommand(database, w.world.business, w.admin.presented, 'api', {
        operationId: randomUUID(),
        command: 'client.bind_site',
        clientId: await alphaClient(),
        repository: `crossing/${own}-${tag}`,
        defaultBranch: 'main',
        project: `prj_crossing_${own}_${tag}`,
        pages,
      } as never);
    } finally {
      await database.close();
    }
  };
  const answers = await Promise.allSettled([bind([one, two], 'a'), bind([two, one], 'b')]);
  expect(answers.map((answer) => outcomeOf(answer)).toSorted()).toEqual([
    'PAGE_BOUND_ELSEWHERE',
    'applied',
  ]);
}

async function crossingStoreWrites(): Promise<void> {
  const own = randomUUID().slice(0, 8);
  const [one, two] = pagesOf(own);
  const pause = meeting();
  const bind = async (pages: readonly Page[], tag: string) => {
    const partyId = await alphaClient();
    const database = connect(w.world.db.appUrl, { source: 'runtime' });
    try {
      return await database.withBusiness(
        w.world.business,
        async (tx) =>
          await bindPartySite(
            pausing(tx, pause),
            {
              partyId,
              repository: `crossing/${own}-${tag}`,
              defaultBranch: 'main',
              project: `prj_crossing_${own}_${tag}`,
              pages,
            },
            w.admin.actorId,
          ),
      );
    } finally {
      await database.close();
    }
  };
  const answers = await Promise.allSettled([bind([one, two], 'a'), bind([two, one], 'b')]);
  const faults = answers.flatMap((answer) => (answer.status === 'rejected' ? [answer.reason] : []));
  expect(faults).toHaveLength(1);
  expect(isRetryableViolation(faults[0])).toBe(true);
}

describe.skipIf(serverUrl === undefined)('two binds of crossing pages at once', () => {
  it(
    'S2333-2 command: one applies and the other is refused PAGE_BOUND_ELSEWHERE, never a fault',
    crossingCommands,
  );
  it(
    "S2333-2 store: a deadlock victim's error is the server's, which the envelope retries",
    crossingStoreWrites,
  );
});
