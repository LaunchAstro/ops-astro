// SPDX-License-Identifier: AGPL-3.0-only
//
// Every transaction the recurring reconciliation pass opens
// (`passEachBusiness` in `apps/api/recovery-entry.ts`) runs under an idle
// limit, so a hosted instance frozen mid-pass once it has answered cannot hold
// its locks: the database ends the transaction and lets them go. Over a real
// database, the pool records the limit in force at the end of each of the
// pass's transactions. It goes red if a pass transaction runs with no idle
// limit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passEachBusiness, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/index.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'the recurring pass and idle transactions',
  { timeout: 60_000 },
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('idlelimit', 1_000_000);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('every transaction of the pass runs under an idle limit', async () => {
      const limits: string[] = [];
      const recording = {
        ...s.db.app,
        withBusiness: async <T>(businessId: string, run: (tx: TenantQuery) => Promise<T>) =>
          await s.db.app.withBusiness(businessId, async (tx) => {
            const answer = await run(tx);
            const [row] = await tx.query<{ limit: string }>(
              "select current_setting('idle_in_transaction_session_timeout') as limit",
            );
            limits.push(String(row?.limit));
            return answer;
          }),
      } as Database;
      const [outcome] = await passEachBusiness(
        recording,
        async () => await Promise.resolve(s.business),
        ['idlelimit'],
        registerEffectLookup,
      );
      expect(outcome?.ok).toBe(true);
      expect(limits.length).toBeGreaterThan(0);
      expect(new Set(limits)).toEqual(new Set(['10s']));
    });
  },
);
