// SPDX-License-Identifier: AGPL-3.0-only
//
// #1860 (S1867-1): two made-up guard installs at once never leave the guard
// without the sign-in list. A refresh, an install given no list, must not
// install a list it read before another install wrote one, and an install
// that writes the list must not leave a moment a refresh could read it empty.
// Sol's proofs from #1867 at 1f96df3 and #1881 at c9111fb, then every pause
// point of each install against the whole of the other.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from './staging-no-production-data.fixture.ts';
import {
  admitBeforeSignIns,
  guardMadeUp,
  productionSigns,
  type OwnerQuery,
} from '../../scripts/ops/made-up-only.ts';
import { createEmptyDatabase } from '../support/fresh-database.ts';

const LIST = ['ada@alpha.local'];

/** The guard's text holds a sign-in list. */
async function restricted(admin: OwnerQuery): Promise<boolean> {
  const [row] = await admin.execute<{ listed: boolean }>(
    `select prosrc like '%<> all (array[%' as listed from pg_proc
      where oid = to_regprocedure('ops_astro_made_up.guard()')`,
  );
  return row?.listed === true;
}

/** An owner connection that runs `between(n)` after its nth statement. */
function stepping(admin: OwnerQuery, between: (n: number) => Promise<void>): OwnerQuery {
  let n = 0;
  return {
    async execute<Row>(sql: string, parameters?: readonly unknown[]) {
      const rows = await admin.execute<Row>(sql, parameters);
      n += 1;
      await between(n);
      return rows;
    },
  };
}

async function withAuthDatabase(part: string, body: (admin: OwnerQuery) => Promise<void>) {
  const db = await createEmptyDatabase({ part });
  try {
    await db.admin.execute('create schema auth');
    await db.admin.execute('create table auth.users (id uuid primary key, email text)');
    await body(db.admin);
  } finally {
    await db.drop();
  }
}

describe.skipIf(serverUrl === undefined)('made-up guard installs at once', () => {
  staleRefresh();
  overlappingInstall();
  refreshPauses();
  installPauses();
});

function staleRefresh(): void {
  it('a refresh started without a list cannot erase a concurrently installed restriction', async () => {
    await withAuthDatabase('staleempty', async (admin) => {
      // Staging or a reset may install the guard before local db:admit supplies a list.
      await guardMadeUp(admin);
      let read!: () => void;
      let resume!: () => void;
      const readList = new Promise<void>((resolve) => {
        read = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const stale: OwnerQuery = {
        async execute<Row>(sql: string, parameters?: readonly unknown[]) {
          const rows = await admin.execute<Row>(sql, parameters);
          if (sql.startsWith('create schema if not exists ops_astro_made_up')) {
            read();
            await resumed;
          }
          return rows;
        },
      };
      const refresh = guardMadeUp(stale);
      await readList;
      try {
        expect(await admitBeforeSignIns(admin, true, LIST)).toEqual([]);
      } finally {
        resume();
      }
      await refresh;
      await admin.execute('insert into auth.users (id, email) values ($1, $2)', [
        randomUUID(),
        `shared-account.${randomUUID().slice(0, 8)}@company.local`,
      ]);
      expect(
        await productionSigns(admin),
        'foreign sign-in must remain refused after both installers complete',
      ).not.toEqual([]);
    });
  }, 600_000);
}

function overlappingInstall(): void {
  it('a list install overlapping a paused refresh completes and retains its restriction', async () => {
    await withAuthDatabase('overlap', async (admin) => {
      await guardMadeUp(admin);
      let overlapped = false;
      const paused: OwnerQuery = {
        async execute<Row>(sql: string, parameters?: readonly unknown[]) {
          const rows = await admin.execute<Row>(sql, parameters);
          if (!overlapped && sql.startsWith('drop event trigger if exists')) {
            overlapped = true;
            expect(await admitBeforeSignIns(admin, true, LIST)).toEqual([]);
          }
          return rows;
        },
      };
      // The inner list install runs wholly while the outer refresh is paused,
      // one of the schedules the pause-point sweeps below cover.
      await expect(guardMadeUp(paused)).resolves.toBeUndefined();
      expect(overlapped).toBe(true);
      await admin.execute('insert into auth.users values ($1, $2)', [
        randomUUID(),
        `shared-account.${randomUUID().slice(0, 8)}@company.local`,
      ]);
      expect(await productionSigns(admin)).not.toEqual([]);
    });
  }, 60_000);
}

function refreshPauses(): void {
  it('a whole list install at any pause in a refresh leaves the list installed', async () => {
    await withAuthDatabase('refreshpause', async (admin) => {
      let steps = 0;
      await guardMadeUp(
        stepping(admin, (n) => {
          steps = n;
          return Promise.resolve();
        }),
      );
      const unlisted: number[] = [];
      for (let pause = 1; pause <= steps; pause += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await guardMadeUp(admin, []);
        // oxlint-disable-next-line no-await-in-loop
        await guardMadeUp(
          stepping(admin, async (n) => {
            if (n === pause) await guardMadeUp(admin, LIST);
          }),
        );
        // oxlint-disable-next-line no-await-in-loop
        if (!(await restricted(admin))) unlisted.push(pause);
      }
      expect(steps).toBeGreaterThan(5);
      expect(unlisted).toEqual([]);
    });
  }, 600_000);
}

function installPauses(): void {
  it('a whole refresh at any pause in a list install leaves the list installed', async () => {
    await withAuthDatabase('installpause', async (admin) => {
      let steps = 0;
      await guardMadeUp(
        stepping(admin, (n) => {
          steps = n;
          return Promise.resolve();
        }),
        LIST,
      );
      const unlisted: number[] = [];
      for (let pause = 1; pause <= steps; pause += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await guardMadeUp(admin, []);
        // oxlint-disable-next-line no-await-in-loop
        await guardMadeUp(
          stepping(admin, async (n) => {
            if (n === pause) await guardMadeUp(admin);
          }),
          LIST,
        );
        // oxlint-disable-next-line no-await-in-loop
        if (!(await restricted(admin))) unlisted.push(pause);
      }
      expect(steps).toBeGreaterThan(5);
      expect(unlisted).toEqual([]);
    });
  }, 600_000);
}
