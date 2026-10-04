// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #770: two first observations of one identifier make one person.
//
// Under read committed both calls could look the identifier up, both find
// nobody, and both create a person; the unique index includes the person, so
// nothing conflicts and every later observation is unresolved between the two.
// The test forces that window rather than hoping for it: each call is held at
// a gate right after its lookup, and the gate opens only once both have looked
// up (nothing serialised them) or one is parked on a lock (something did). A
// run that reaches neither state throws instead of passing quietly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveIdentifier,
  type IdentifierResolution,
} from '../../packages/core-records/src/identity/identifier-resolution.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { countRows, insertBusiness } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('identifier first-sighting race: DATABASE_URL is unset, so nothing was proved.');
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** How long the interleaving is given to appear. Generous, and finite. */
const WITHIN = 10_000;

// The lookup `resolveIdentifier` matches on. A call is held right after it,
// which is the window two first observations race through.
const LOOKUP = /from public\.person_identifiers\s+where kind/u;

/**
 * A gate both calls stop at after their lookup. It opens once both have
 * looked up (nothing serialised them) or once one has looked up and the other
 * is parked on a lock (something did); it stays open after that. A run that
 * reaches neither state throws rather than passing quietly.
 */
function lookupGate(db: FreshDatabase): {
  readonly held: (tx: TenantQuery) => TenantQuery;
  readonly lookups: () => number;
} {
  let arrived = 0;
  let open: Promise<void> | undefined;
  const watch = async (deadline: number): Promise<void> => {
    if (arrived >= 2) return;
    const blocked = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
    );
    if (Number(blocked[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('neither both lookups ran nor did the second call wait on a lock');
    }
    await delay(25);
    await watch(deadline);
  };
  return {
    lookups: () => arrived,
    held: (tx) => ({
      businessId: tx.businessId,
      async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
        const rows = await tx.query<Row>(text, parameters);
        if (LOOKUP.test(text)) {
          arrived += 1;
          open ??= watch(Date.now() + WITHIN);
          await open;
        }
        return rows;
      },
    }),
  };
}

function personOf(resolution: IdentifierResolution): string {
  if (resolution.outcome !== 'attached')
    throw new Error('expected an attachment, and it was unresolved');
  return resolution.personId;
}

describe.skipIf(serverUrl === undefined)('two first observations of one identifier at once', () => {
  let db: FreshDatabase;
  let second: Database;
  let business: string;

  const observe = async (value: string): Promise<IdentifierResolution> =>
    await db.app.withBusiness(business, (tx) =>
      resolveIdentifier(tx, { kind: 'email', value, sourceSystem: 'import' }),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'b' });
    business = await insertBusiness(db.app, 'first-sighting');
    // A second connection, because the first is `max: 1` and two
    // transactions on it would queue in the pool rather than race.
    second = connect(db.appUrl, { source: 'runtime' });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  it('make one person, and a third observation attaches to that person', async () => {
    const gate = lookupGate(db);
    const people = async (): Promise<number> =>
      await db.app.withBusiness(business, (tx) => countRows(tx, 'people'));
    const before = await people();
    const value = 'first-seen@example.com';
    const observation = { kind: 'email', value, sourceSystem: 'import' } as const;
    const [one, two] = await Promise.all([
      db.app.withBusiness(business, (tx) => resolveIdentifier(gate.held(tx), observation)),
      second.withBusiness(business, (tx) => resolveIdentifier(gate.held(tx), observation)),
    ]);
    // Both calls went through the gate, so the window was held open.
    expect(gate.lookups()).toBe(2);
    expect(personOf(two)).toBe(personOf(one));
    expect(await people()).toBe(before + 1);
    expect(personOf(await observe(value))).toBe(personOf(one));
  }, 30_000);
});
