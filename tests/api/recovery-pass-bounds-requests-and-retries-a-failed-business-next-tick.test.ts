// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs (#1368's removal check, #287): a stalled lookup does not hold
// sign-in past the request bound, a key that does not resolve is logged once a
// tick rather than once a request, and a business that rolls back on every
// tick does not stop a later business's expired lease from being retired.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it as vitestIt, vi } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import * as recovery from '../../apps/api/recovery-entry.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { Client, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, openSchedules, seedSchedules } from '../runtime/schedules-harness.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

const signIn = () =>
  new Request('https://ops.example.test/api/sign-in', {
    headers: { host: 'ops.example.test' },
  });

function settings(database: string, lookup: string, keys: string) {
  const id = 'test/sol1368-rollback@1';
  return {
    DATABASE_URL: database,
    DATABASE_LOOKUP_URL: lookup,
    GOTRUE_URL: TEST_ISSUER,
    SERVED_HOST: 'ops.example.test',
    DELEGATION_CREDENTIAL_KEY_ID: id,
    DELEGATION_CREDENTIAL_KEYS: `${id}:${randomBytes(32).toString('base64url')}`,
    RECOVERY_BUSINESS_KEYS: keys,
  };
}

it('Sol proof, criterion 3: a stalled lookup does not hold sign-in beyond the request bound', async () => {
  const s = await openSchedules('sol1368lookup', 100_000);
  const url = new URL(databaseUrlFromEnvironment()!);
  url.pathname = `/${s.db.name}`;
  const holder = new Client(url.toString());
  let response: Promise<Response> | undefined;
  let handle: ReturnType<typeof createFunctionHandler> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    const lookup = await loginIn(s.db, 'ops_astro_lookup', 'sollookup');
    handle = createFunctionHandler(settings(s.db.appUrl, lookup.url, 'schedules-sol1368lookup'));
    await holder.query('begin');
    await holder.query('lock table public.businesses in access exclusive mode');
    response = handle(signIn());
    await expect
      .poll(async () => {
        const [row] = await s.db.admin.execute<{ waiting: boolean }>(
          `select exists (select 1 from pg_stat_activity where datname = current_database()
           and wait_event_type = 'Lock' and query ilike '%businesses%') as waiting`,
        );
        return row?.waiting;
      })
      .toBe(true);
    const result = await Promise.race([
      response.then((answer) => answer.status),
      new Promise<'held'>((resolve) => {
        deadline = setTimeout(() => resolve('held'), 3_500);
      }),
    ]);
    expect(
      result,
      'sign-in was held beyond the 2-second recovery bound plus response allowance',
    ).toBe(200);
  } finally {
    clearTimeout(deadline);
    await holder.query('rollback');
    await response;
    await handle?.(signIn());
    await holder.end();
    await s.db.drop();
  }
}, 30_000);

it('Sol proof, criterion 3: an unresolved recovery key is logged once within one tick', async () => {
  const s = await openSchedules('sol1368backoff', 100_000);
  const lines: string[] = [];
  const capture = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    const lookup = await loginIn(s.db, 'ops_astro_lookup', 'solbackoff');
    const handle = createFunctionHandler(
      settings(s.db.appUrl, lookup.url, 'no-such-sol1368-business'),
    );
    for (let request = 0; request < 3; request += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await handle(signIn())).status).toBe(200);
    }
    expect(lines.filter((line) => line.startsWith('api: reconciliation pass'))).toHaveLength(1);
  } finally {
    capture.mockRestore();
    await s.db.drop();
  }
}, 30_000);

it('Sol proof, criterion 9: recurring recovery retires B lease and releases B hold while A keeps rolling back', async () => {
  const a = await openSchedules('sol1368first', 100_000);
  try {
    const b = await seedSchedules(a.db, 'sol1368later', 100_000);
    const work = await liveWork(b, 'Expired work after a persistently failing business', 1_000);
    await a.db.admin.execute(
      "update public.leases set expires_at = clock_timestamp() - interval '1 minute' where id = $1",
      [work.picked['leaseId']],
    );
    let failed = 0;
    const database: Database = {
      ...a.db.app,
      withBusiness: async (businessId, run) => {
        if (businessId === a.business) {
          failed += 1;
          return await a.db.app.withBusiness(businessId, async () => {
            throw new Error('A transaction rolls back on every recurring tick');
          });
        }
        return await a.db.app.withBusiness(businessId, run);
      },
    };
    const source = readFileSync(new URL('../../apps/api/server.ts', import.meta.url), 'utf8');
    const name = source.match(/return await (passEachBusiness|passDeployment)\(/u)?.[1];
    expect(name, 'use the entry point actually wired to the server sweeper').toBeDefined();
    const recurring = Reflect.get(recovery, name!) as typeof recovery.passDeployment;
    for (let tick = 0; tick < 2; tick += 1) {
      // eslint-disable-next-line no-await-in-loop
      await recurring(
        database,
        async (key) => (key === 'alpha' ? a.business : b.business),
        ['alpha', 'bravo'],
        recovery.registerEffectLookup,
      );
    }
    expect(failed).toBe(2);
    const [state] = await a.db.admin.execute<{
      lease: string;
      reservation: string;
      outstanding: string;
      cause: string;
      terminal: boolean;
    }>(
      `select l.state as lease, r.state as reservation,
              (case when r.state = 'held' then r.held_minor else 0 end)::text as outstanding,
              r.classified_cause as cause, r.terminal_at is not null as terminal
         from public.leases l
         join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
         join public.task_envelopes e on e.business_id = r.business_id and e.id = r.envelope_id
        where l.business_id = $1 and l.id = $2`,
      [b.business, work.picked['leaseId']],
    );
    expect(state, 'B remained live and held despite two recurring recovery ticks').toMatchObject({
      lease: 'expired',
      reservation: 'abandoned',
      outstanding: '0',
      cause: 'lease_expired_and_fenced',
      terminal: true,
    });
  } finally {
    await a.db.drop();
  }
}, 60_000);
