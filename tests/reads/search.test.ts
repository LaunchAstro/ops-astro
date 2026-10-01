// SPDX-License-Identifier: AGPL-3.0-only
//
// C1a: the one scoped query service, `task.search`.
//
// Two checklist lines (ticket C1, lines C2 and C3); the first is three
// `describe` blocks under its name, over one database seeded for the file:
//
//  - **C1 scope before candidates.** The viewer's live grants are part of the
//    statement that finds candidates, never a filter over what it found. A
//    post-filter build answers the same list, so the list alone cannot tell
//    the two apart; what does is every row the database hands the process.
//    The read runs over a transaction that records each row returned, and no
//    row may name the other client's task or carry its word. A person with
//    one client's grant gets nothing for the other client's word, not even a
//    count. Client to client, person to person and business to business.
//  - **C1 one scoped query service.** The read serves `searchTasks` and
//    nothing else, so the ledger, the Docs panel and C84's erasure canary call
//    the same function the API and the command line reach.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { withSession } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { runRead } from '../../packages/core-commands/src/reads/dispatch.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { readTaskSpine } from '../../packages/core-commands/src/commands/context.ts';
import { searchTasks } from '../../packages/core-commands/src/reads/search.ts';
import { READ_CATALOGUE } from '../../packages/core-commands/src/reads/catalogue.ts';
import { declarationOf, pathOf } from '../../packages/core-wire/src/surface.ts';
import { accepts, isWrite } from '../../apps/cli/client.ts';
import type { ReadRequest, ReadResult } from '../../packages/core-commands/src/reads/requests.ts';
import type { CommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task.search: DATABASE_URL is unset, so nothing below ran.');
}

// One word per client, and one the other business holds too. Each is unique
// to its title, so a hit or a returned row naming it is unambiguous.
const ACME_WORD = 'zephyrine';
const BOREAL_WORD = 'quixotical';

function hitIds(result: ReadResult | CommandRefusal): readonly string[] {
  if (isCommandRefusal(result)) throw new Error(`refused ${result.code}`);
  if (!('hits' in result)) throw new Error('task.search answered something else');
  return result.hits.map((hit) => hit.id);
}

let db: FreshDatabase;
let alpha: string;
let beta: string;
/** Reads every task in alpha. */
let mia: Member;
/** Holds `task:read` on Acme's task and nothing else. */
let ann: Member;
/** Holds `task:read` on Boreal's task and nothing else. */
let ben: Member;
/** A member of alpha holding no grant on tasks. */
let noah: Member;
/** Reads every task in beta. */
let bea: Member;
let acmeTask: string;
let borealTask: string;
let betaTask: string;

const create = async (business: string, who: Member, title: string): Promise<string> => {
  const created = await executeCommand(db.app, business, who.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  } as never);
  if (isCommandRefusal(created) || created.recordId === null) {
    throw new Error(`task.create: ${JSON.stringify(created)}`);
  }
  return created.recordId;
};

const search = async (who: Member, query: unknown, business = alpha) =>
  await executeRead(db.app, business, who.presented, {
    read: 'task.search',
    query,
  } as ReadRequest);

/** The read, with every row the database returned to the process kept. */
const searchWatched = async (who: Member, query: string) => {
  const returned: unknown[] = [];
  const result = await withSession(db.app, alpha, who.presented, async (tx, session) => {
    const watched: TenantQuery = {
      businessId: tx.businessId,
      async query<Row>(text: string, parameters?: readonly unknown[]) {
        const rows = await tx.query<Row>(text, parameters);
        returned.push(...rows);
        return rows;
      },
    };
    return await runRead(watched, session, { read: 'task.search', query });
  });
  return { result, returned: JSON.stringify(returned) };
};

// One database for every case in the file; nothing runs without a server.
beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c1a' });
  alpha = await insertBusiness(db.app, 'alpha');
  beta = await insertBusiness(db.app, 'beta');
  await installSpine(db.app, alpha);
  await installSpine(db.app, beta);
  mia = await enrol(db.app, alpha, 'mia');
  ann = await enrol(db.app, alpha, 'ann');
  ben = await enrol(db.app, alpha, 'ben');
  noah = await enrol(db.app, alpha, 'noah');
  bea = await enrol(db.app, beta, 'bea');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, mia, 'read');
    await grantTo(tx, mia, 'write');
    await grantTo(tx, mia, 'share');
  });
  await db.app.withBusiness(beta, async (tx) => {
    await grantTo(tx, bea, 'read');
    await grantTo(tx, bea, 'write');
  });
  acmeTask = await create(alpha, mia, `Acme ${ACME_WORD} brochure`);
  borealTask = await create(alpha, mia, `Boreal ${BOREAL_WORD} invoice`);
  betaTask = await create(beta, bea, `Beta ${ACME_WORD} ${BOREAL_WORD} copy`);
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ann, 'read', { kind: 'record', id: acmeTask });
    await grantTo(tx, ben, 'read', { kind: 'record', id: borealTask });
  });
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)(
  'C1 scope before candidates: client, person and business',
  () => {
    it('one client’s grant finds nothing of the other client’s word, not even a count', async () => {
      const { result, returned } = await searchWatched(ann, BOREAL_WORD);
      expect(result).toStrictEqual({ ok: true, hits: [] });
      // Never read: no row the database returned names Boreal's task or its word.
      expect(returned).not.toContain(borealTask);
      expect(returned.toLowerCase()).not.toContain(BOREAL_WORD);
    });

    it('the same grant finds its own client’s task, by part of its name', async () => {
      const { result, returned } = await searchWatched(ann, 'zephyr');
      expect(hitIds(result)).toStrictEqual([acmeTask]);
      expect(returned).not.toContain(borealTask);
    });

    it('person to person: the other client’s holder is scoped the same way', async () => {
      const { result, returned } = await searchWatched(ben, ACME_WORD);
      expect(result).toStrictEqual({ ok: true, hits: [] });
      expect(returned).not.toContain(acmeTask);
      expect(hitIds(await search(ben, BOREAL_WORD))).toStrictEqual([borealTask]);
    });

    it('business to business: a business-wide reader sees its own and never another’s', async () => {
      expect(hitIds(await search(mia, ACME_WORD))).toStrictEqual([acmeTask]);
      expect(hitIds(await search(mia, BOREAL_WORD))).toStrictEqual([borealTask]);
      expect(hitIds(await search(bea, ACME_WORD, beta))).toStrictEqual([betaTask]);
    });

    it('a revoked grant stops finding on the next call', async () => {
      const carl = await enrol(db.app, alpha, 'carl');
      const grant = await db.app.withBusiness(
        alpha,
        async (tx) => await grantTo(tx, carl, 'read', { kind: 'record', id: acmeTask }),
      );
      expect(hitIds(await search(carl, ACME_WORD))).toStrictEqual([acmeTask]);
      await db.app.withBusiness(alpha, async (tx) => {
        await tx.query(`update grants set revoked_at = now() where business_id = $1 and id = $2`, [
          tx.businessId,
          grant,
        ]);
      });
      const after = await search(carl, ACME_WORD);
      expect(isCommandRefusal(after) ? after.code : after).toBe('SCOPE_NOT_GRANTED');
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C1 scope before candidates: refusals name nothing',
  () => {
    it('a member holding no task grant is refused, never answered with an empty list', async () => {
      const result = await search(noah, ACME_WORD);
      expect(isCommandRefusal(result) ? result.code : result).toBe('SCOPE_NOT_GRANTED');
    });

    it('an external party is refused: the portal has no search until one is designed', async () => {
      const client = await shareWithClient(db.app, alpha, mia, acmeTask);
      const { result, returned } = await searchWatched(client, ACME_WORD);
      expect(isCommandRefusal(result) ? result.code : result).toBe('SCOPE_NOT_GRANTED');
      // Refused before any task is read: no task row came back, and the body names nothing.
      for (const canary of [acmeTask, borealTask, ACME_WORD, BOREAL_WORD]) {
        expect(returned).not.toContain(canary);
        expect(JSON.stringify(result)).not.toContain(canary);
      }
    });

    it('a refusal for holding no grant carries no id, title or count', async () => {
      const result = await search(noah, BOREAL_WORD);
      for (const canary of [acmeTask, borealTask, BOREAL_WORD, 'Boreal']) {
        expect(JSON.stringify(result)).not.toContain(canary);
      }
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C1 scope before candidates: hostile and malformed queries',
  () => {
    it('hostile queries never widen the scope and never fault', async () => {
      const hostile = [
        `${ACME_WORD} | ${BOREAL_WORD}`,
        `${ACME_WORD}:* | ${BOREAL_WORD}:*`,
        `!${ACME_WORD} & ${BOREAL_WORD}`,
        `'${BOREAL_WORD}' or 1=1 --`,
        `${BOREAL_WORD.toUpperCase()}\t${ACME_WORD}`,
        `(${BOREAL_WORD}) <-> *`,
        `%${BOREAL_WORD}%`,
        `ＱＵＩＸＯＴＩＣＡＬ`,
      ];
      for (const query of hostile) {
        // oxlint-disable-next-line no-await-in-loop
        const { result, returned } = await searchWatched(ann, query);
        expect(isCommandRefusal(result), query).toBe(false);
        expect(hitIds(result), query).not.toContain(borealTask);
        expect(returned, query).not.toContain(borealTask);
      }
    });

    it('a record identifier in the body is refused, not ignored', async () => {
      const result = await executeRead(db.app, alpha, ann.presented, {
        read: 'task.search',
        query: ACME_WORD,
        recordId: borealTask,
      } as ReadRequest);
      expect(isCommandRefusal(result) ? [result.code, result.names] : result).toStrictEqual([
        'COMMAND_BODY_INVALID',
        ['recordId'],
      ]);
    });

    it('refuses a query with no word in it, and one over 200 characters', async () => {
      for (const query of [undefined, 7, '', '  ', '&|!:*', 'a'.repeat(201)]) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await search(mia, query);
        expect(isCommandRefusal(result) ? result.names : result).toStrictEqual(['query']);
      }
    });
  },
);

describe.skipIf(serverUrl === undefined)('C1 one scoped query service', () => {
  it('the read answers exactly what searchTasks answers', async () => {
    const direct = await withSession(db.app, alpha, ann.presented, async (tx, session) => {
      const spine = await readTaskSpine(tx);
      return await searchTasks(tx, session, { taskTypeId: spine.taskTypeId, query: ACME_WORD });
    });
    expect(await search(ann, ACME_WORD)).toStrictEqual(direct);
  });

  it('is a read on the API and the command line, asked as the viewer’s own scope', () => {
    expect(declarationOf('task.search')).toMatchObject({ kind: 'read', collection: 'task' });
    expect(pathOf('task.search')).toBe('/task/search');
    expect(accepts('task.search')).toBe(true);
    expect(isWrite('task.search')).toBe(false);
    expect(READ_CATALOGUE['task.search'].authority).toBe('holds-any-grant');
  });
});
