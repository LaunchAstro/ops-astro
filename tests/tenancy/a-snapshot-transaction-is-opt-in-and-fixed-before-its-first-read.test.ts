// SPDX-License-Identifier: AGPL-3.0-only
//
// withBusiness's isolation option (#2337, ORCH-2114-SEAM). Every transaction
// is read committed unless its caller asks for repeatable read, and then the
// wrapper's own first statement, the business setting, fixes the one snapshot
// the caller's statements all read: a row committed after it stays unseen. The
// option changes when a transaction looks, never which business it looks at.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  type BusinessId,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('snapshot option: DATABASE_URL is unset, so nothing below ran.');
}

const level = async (tx: TransactionQuery): Promise<string | undefined> => {
  const [row] = await tx.query<{ readonly level: string }>(
    `select current_setting('transaction_isolation') as level`,
  );
  return row?.level;
};

let db: FreshDatabase;
let repeatableByDefault: Database;
const alpha = randomUUID() as BusinessId;
const beta = randomUUID() as BusinessId;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'snapshot' });
  const add = (id: BusinessId, key: string): Promise<void> =>
    db.app.withBusiness(id, async (tx) => {
      await tx.query('insert into businesses (business_id, id, key, name) values ($1,$1,$2,$3)', [
        id,
        key,
        key,
      ]);
    });
  await add(alpha, 'alpha');
  await add(beta, 'beta');
  // A login whose own default is repeatable read: the default call must still say read committed.
  const url = new URL(db.appUrl);
  url.searchParams.set('default_transaction_isolation', 'repeatable read');
  repeatableByDefault = connect(url.toString(), { source: 'runtime', max: 2 });
}, 60_000);

afterAll(async () => {
  await repeatableByDefault?.close();
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('withBusiness: read committed unless asked', () => {
  it('runs read committed when no isolation is asked for, whatever the login default', async () => {
    expect(await db.app.withBusiness(alpha, level)).toBe('read committed');
    expect(await repeatableByDefault.withBusiness(alpha, level)).toBe('read committed');
    expect(
      await repeatableByDefault.withBusiness(alpha, level, { deadline: Date.now() + 30_000 }),
    ).toBe('read committed');
    expect(await db.app.withBusiness(alpha, level, { isolation: 'read committed' })).toBe(
      'read committed',
    );
  });
});

describe.skipIf(serverUrl === undefined)('withBusiness: repeatable read on request', () => {
  it('runs repeatable read when asked', async () => {
    expect(await db.app.withBusiness(alpha, level, { isolation: 'repeatable read' })).toBe(
      'repeatable read',
    );
  });

  it('fixes the snapshot at the business setting, before the first statement of the caller', async () => {
    const name = (tx: TransactionQuery): Promise<readonly { readonly name: string }[]> =>
      tx.query<{ readonly name: string }>('select name from businesses where id = $1', [alpha]);
    const renameDuring = async (
      options: { readonly isolation?: 'repeatable read' },
      to: string,
    ): Promise<string | undefined> =>
      await db.app.withBusiness(
        alpha,
        async (tx) => {
          // The wrapper has sent its setting and nothing of ours yet: commit a change elsewhere now.
          await db.admin.execute('update businesses set name = $2 where id = $1', [alpha, to]);
          const [row] = await name(tx);
          return row?.name;
        },
        options,
      );

    expect(await renameDuring({}, 'renamed once')).toBe('renamed once');
    expect(await renameDuring({ isolation: 'repeatable read' }, 'renamed twice')).toBe(
      'renamed once',
    );
    const [after] = await db.app.withBusiness(alpha, name);
    expect(after?.name).toBe('renamed twice');
  });
});

describe.skipIf(serverUrl === undefined)('withBusiness: the option is not a door', () => {
  it('keeps one business in a repeatable read transaction, as in any other', async () => {
    const seen = await db.app.withBusiness(
      alpha,
      async (tx) => ({
        all: await tx.query<{ readonly key: string }>('select key from businesses'),
        other: await tx.query('select key from businesses where id = $1', [beta]),
      }),
      { isolation: 'repeatable read' },
    );
    expect(seen.all.map((row) => row.key)).toStrictEqual(['alpha']);
    expect([...seen.other]).toStrictEqual([]);
    await expect(
      db.app.withBusiness(
        alpha,
        async (tx) => {
          await tx.query(
            'insert into businesses (business_id, id, key, name) values ($1,$1,$2,$3)',
            [randomUUID(), 'smuggled', 'Smuggled'],
          );
        },
        { isolation: 'repeatable read' },
      ),
    ).rejects.toThrow(/row-level security/iu);
  });

  it('refuses an isolation it does not offer, before the server sees it', async () => {
    await expect(
      db.app.withBusiness(alpha, level, { isolation: 'serializable' as 'repeatable read' }),
    ).rejects.toThrow(/is not an isolation withBusiness offers/u);
    await expect(
      db.app.withBusiness(alpha, level, {
        isolation: 'read committed; select 1 --' as 'repeatable read',
      }),
    ).rejects.toThrow(/is not an isolation withBusiness offers/u);
  });
});
