// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's stream checks the bearer once per run. Each signal it hears runs
// the rule once: the reader's tasks and inbox digested and the join asked
// again (ORCH46, so a bearer revoked or remapped since is caught by that run),
// and those questions share one verification rather than each verifying the
// bearer again. Through the real routes over a real database, counting the
// verifier's calls: one task event is one more verification, and a second
// event is one more again. It goes red if a run verifies the bearer more than
// once, or if a signal stops asking at all.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier, type Verifier } from '../../apps/api/auth/supabase.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { admitReads, executeCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { connect, connectListener, type Database } from '../../packages/core-records/src/index.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { authorised, ISSUER, tokenFor } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
/** Long enough that no recheck runs inside a case: every run is a signal's. */
const RECHECK_MS = 60_000;
/** Long enough for one run's questions to finish after its signal. */
const SETTLE_MS = 600;

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Reads a stream to its end. */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<void> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one frame after another
    if (reader === undefined || (await reader.read()).done) return;
  }
}

let s: Schedules;
let key: string;
let pool: Database;
let topics: LiveTopics;
let api: Hono;
let verified = 0;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('boardchecks', 1_000_000);
  const [row] = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [s.business],
  );
  key = String(row?.key);
  pool = connect(s.db.appUrl, { max: 4 });
  topics = await startLiveTopics(connectListener(s.db.appUrl));
  const real = createSupabaseVerifier(testSignIn(ISSUER));
  const verify: Verifier = async (request) => {
    verified += 1;
    return await real(request);
  };
  api = createApi({
    database: pool,
    verify,
    resolveBusiness: createBusinessResolver(s.db.admin),
    executeRead,
    executeCommand,
    live: { topics, recheckMs: RECHECK_MS, admit: admitReads },
  });
}, 180_000);

afterAll(async () => {
  await reader?.cancel().catch(() => {});
  await topics?.close();
  await pool?.close();
  await s?.db.drop();
});

/** The board's stream for the decider, read to its end in the background. */
async function openBoard(): Promise<void> {
  const response = await api.fetch(
    new Request(`http://api.test${PREFIX.person}${key}/live`, {
      headers: authorised(await tokenFor(s.decider.presented.subject)),
    }),
  );
  expect(response.status).toBe(200);
  reader = response.body?.getReader();
  // Read every frame, so no write waits on the reader.
  void readAll(reader).catch(() => {});
  // The join's own run, before any event.
  await sleep(SETTLE_MS);
}

it.skipIf(serverUrl === undefined)(
  'one task event is one verification, and the next event one more',
  { timeout: 30_000 },
  async () => {
    const taskId = await createTask(s, `board-checks-${randomUUID()}`);
    await openBoard();
    const touch = async (): Promise<void> => {
      await pool.withBusiness(s.business, async (tx) => {
        await tx.query('update public.records set data = data where id = $1', [taskId]);
      });
      await sleep(SETTLE_MS);
    };
    const before = verified;
    await touch();
    expect(verified - before, 'verifications in one run').toBe(1);
    await touch();
    expect(verified - before, 'verifications in two runs').toBe(2);
  },
);
