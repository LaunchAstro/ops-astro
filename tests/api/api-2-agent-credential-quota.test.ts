// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 quota: an agent credential's calls are held to per-credential,
// per-person and per-business limits on requests a minute, calls in flight
// and records handed out a minute, each refused under a burst with the same
// clear answer and nothing run. The limits are the app's (`agent-quota.ts`);
// each case builds the world's composition with small ones.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { AgentLimits } from '../../apps/api/auth/agent-quota.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import {
  apiWith,
  asCredential,
  comment,
  issued,
  latch,
  wordsOf,
  type Api,
} from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
const READ_ONLY = { scope: [{ collection: 'task', action: 'read' }] };
const WIDE = { credential: 1000, person: 1000, business: 1000 };

function limited(
  overrides: Partial<AgentLimits>,
  database: Database = harness.world.db.app,
): { api: Api; tick: (ms: number) => void } {
  let clock = Date.now();
  const api = apiWith({
    database,
    agentCredentials: {
      now: () => new Date(clock),
      limits: { requests: WIDE, concurrent: WIDE, exports: WIDE, refused: 1000, ...overrides },
    },
  });
  return { api, tick: (ms) => (clock += ms) };
}

const readWith = async (api: Api, secret: string): Promise<Answer> =>
  await asCredential('task.read', { recordId: harness.alphaTask.id }, bearer(secret), api);

/** Answers' codes, sorted, so a burst reads the same whatever order it settled in. */
const codesOf = (answers: readonly Answer[]): string[] =>
  answers.map((answer) => answer.code).toSorted();

function expectClearRefusal(answer: Answer | undefined, secret: string): void {
  expect(answer?.status).toBe(429);
  expect(answer?.code).toBe('AGENT_QUOTA_EXCEEDED');
  expect(wordsOf(answer as Answer)).toMatch(/wait/iu);
  expect(answer?.text).not.toContain(secret);
}

needsServer(
  'API-2 quota: per-credential, per-person and per-business request, concurrency and export limits hold under a burst, with a clear refusal',
  async () => {
    const { api, tick } = limited({ requests: { ...WIDE, credential: 3 } });
    const one = await issued();
    const burst = await Promise.all(
      Array.from({ length: 5 }, async () => await readWith(api, one.secret)),
    );
    expect(codesOf(burst)).toEqual([
      'AGENT_QUOTA_EXCEEDED',
      'AGENT_QUOTA_EXCEEDED',
      'ok',
      'ok',
      'ok',
    ]);
    expectClearRefusal(
      burst.find((answer) => answer.code !== 'ok'),
      one.secret,
    );
    // Another credential is not held by this one's count, and a minute later
    // this one is served again.
    const other = await issued();
    expect((await readWith(api, other.secret)).code).toBe('ok');
    tick(61_000);
    expect((await readWith(api, one.secret)).code).toBe('ok');
  },
);

needsServer('API-2 quota per person: two credentials of one person share its limit', async () => {
  const { api } = limited({ requests: { ...WIDE, person: 3 } });
  const [first, second] = [await issued(), await issued()];
  const burst = await Promise.all(
    [first, second, first, second, first].map(async (one) => await readWith(api, one.secret)),
  );
  expect(codesOf(burst).filter((code) => code === 'ok')).toHaveLength(3);
  // Another person's credential is outside Ada's count.
  const noahs = await issued(READ_ONLY, harness.world.noah.token);
  expect((await readWith(api, noahs.secret)).code).toBe('ok');
});

needsServer(
  'API-2 quota per business: two people’s credentials share the business’s limit',
  async () => {
    const { api } = limited({ requests: { ...WIDE, business: 3 } });
    const adas = await issued();
    const noahs = await issued(READ_ONLY, harness.world.noah.token);
    const burst = await Promise.all(
      [adas, noahs, adas, noahs, adas].map(async (one) => await readWith(api, one.secret)),
    );
    expect(codesOf(burst).filter((code) => code === 'ok')).toHaveLength(3);
  },
);

needsServer(
  'API-2 quota in flight: a call past the concurrency limit is refused at once',
  async () => {
    // A pool of its own, wide enough that two calls are in flight at once.
    const pool = connect(harness.world.db.appUrl, { source: 'runtime', max: 3 });
    const { api } = limited({ concurrent: { ...WIDE, credential: 1 } }, pool);
    const credential = await issued();
    // The task's row lock holds the first call in flight.
    const hold = latch();
    const locked = latch();
    // On its own connection, so the calls keep the world's pool.
    const own = connect(harness.world.db.appUrl, { source: 'runtime', max: 1 });
    const holding = own.withBusiness(harness.world.alpha, async (tx) => {
      await tx.query('select id from public.records where id = $1 for update', [
        harness.alphaTask.id,
      ]);
      locked.open();
      await hold.promise;
    });
    await locked.promise;
    const first = comment(bearer(credential.secret), api);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    const second = await readWith(api, credential.secret).finally(hold.open);
    await holding.finally(async () => await own.close());
    expectClearRefusal(second, credential.secret);
    expect((await first).code).toBe('ok');
    const back = await readWith(api, credential.secret).finally(async () => await pool.close());
    expect(back.code, 'its slot is back').toBe('ok');
  },
);

needsServer('API-2 quota on export: records handed out past the limit are refused', async () => {
  const { api } = limited({ exports: { ...WIDE, credential: 2 } });
  const credential = await issued();
  expect((await readWith(api, credential.secret)).code).toBe('ok');
  expect((await readWith(api, credential.secret)).code).toBe('ok');
  expectClearRefusal(await readWith(api, credential.secret), credential.secret);
});

needsServer(
  'API-2 quota at the door: made-up bearers on a business key are limited before they are resolved',
  async () => {
    const { api, tick } = limited({ refused: 2 });
    const before = await attemptsIn(harness.world.alpha);
    const made = async (): Promise<Answer> =>
      await readWith(api, randomBytes(32).toString('base64url'));
    expect((await made()).code).toBe('DELEGATION_NOT_LIVE');
    expect((await made()).code).toBe('DELEGATION_NOT_LIVE');
    const third = await made();
    expect(third.status).toBe(429);
    expect(third.code).toBe('AGENT_QUOTA_EXCEEDED');
    // The third was turned away before its transaction: no attempt row.
    expect(await attemptsIn(harness.world.alpha)).toBe(before + 2);
    tick(61_000);
    expect((await made()).code).toBe('DELEGATION_NOT_LIVE');
  },
);

needsServer(
  'API-2 quota at the door: a live credential is still served once made-up bearers fill the door',
  async () => {
    const { api } = limited({ refused: 2 });
    const live = await issued();
    const made = async (): Promise<Answer> =>
      await readWith(api, randomBytes(32).toString('base64url'));
    await made();
    await made();
    const before = await attemptsIn(harness.world.alpha);
    const past = await Promise.all([made(), made(), made()]);
    expect(codesOf(past)).toEqual(Array.from({ length: 3 }, () => 'AGENT_QUOTA_EXCEEDED'));
    // Past the cap a made-up bearer writes no attempt row.
    expect(await attemptsIn(harness.world.alpha)).toBe(before);
    expect((await readWith(api, live.secret)).code).toBe('ok');
  },
);

async function attemptsIn(businessId: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.authentication_attempts where business_id = $1',
    [businessId],
  );
  return Number(rows[0]?.n ?? '-1');
}
