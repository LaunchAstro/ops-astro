// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, no-promise-executor-return -- a reviewer's proof, its body kept as written */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { admitReads, executeCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { connect, connectListener, type Database } from '../../packages/core-records/src/index.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { authorised, ISSUER, tokenFor } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
let s: Schedules;
let pool: Database;
let topics: LiveTopics;
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

beforeAll(async () => {
  if (serverUrl === undefined) throw new Error('this proof requires a throwaway database');
  s = await openSchedules('sol1368sharing', 1_000_000);
  pool = connect(s.db.appUrl, { max: 4 });
  topics = await startLiveTopics(connectListener(s.db.appUrl));
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(readers.map(async (reader) => await reader.cancel()));
  await topics?.close();
  await pool?.close();
  await s?.db.drop();
});

it('two boards with one credential share admission for one task event', async () => {
  const task = await createTask(s, 'sol1368-board-sharing');
  const [row] = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [s.business],
  );
  let verified = 0;
  let transactions = 0;
  const real = createSupabaseVerifier(testSignIn(ISSUER));
  const counted: Database = {
    ...pool,
    withBusiness: async (businessId, run) => {
      transactions += 1;
      return await pool.withBusiness(businessId, run);
    },
  };
  const api = createApi({
    database: counted,
    verify: async (request) => {
      verified += 1;
      return await real(request);
    },
    resolveBusiness: createBusinessResolver(s.db.admin),
    executeRead,
    executeCommand,
    live: { topics, recheckMs: 60_000, admit: admitReads },
  });
  const token = await tokenFor(s.decider.presented.subject);
  const open = async () => {
    const response = await api.fetch(
      new Request(`http://api.test/api/b/${String(row?.key)}/live`, { headers: authorised(token) }),
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('stream has no body');
    readers.push(reader);
    void (async () => {
      // eslint-disable-next-line no-await-in-loop -- one frame after another
      while (!(await reader.read()).done) {
        /* Drain frames. */
      }
    })().catch(() => {});
  };
  await open();
  await open();
  // Both initial runs must finish before measuring the single event.
  await expect.poll(() => transactions).toBe(8);
  const beforeVerified = verified;
  const beforeTransactions = transactions;
  await pool.withBusiness(s.business, async (tx) => {
    await tx.query('update public.records set data = data where id = $1', [task]);
  });
  await expect.poll(() => transactions - beforeTransactions).toBeGreaterThanOrEqual(3);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect
    .soft(verified - beforeVerified, 'same credential verified separately per open board')
    .toBe(1);
  expect(
    transactions - beforeTransactions,
    'same reader admission and digests queried separately per open board',
  ).toBe(3);
}, 30_000);
