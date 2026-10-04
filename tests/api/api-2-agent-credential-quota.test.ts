// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 quota: an agent credential's calls are held to per-credential,
// per-person and per-business limits on requests a minute, calls in flight
// and records handed out a minute, each refused with the same clear answer,
// naming no secret. The limits are the app's (`agent-quota.ts`). Each case
// makes one limit at one level small and leaves the rest wide, so its refusal
// can only come from that limit (catalogue #721): requests under a burst,
// calls in flight with the first held on the task's row lock, and records
// handed out in turn. The export count lands when an answer leaves, so a
// burst of reads is not held to it until #595 reserves it on entry. Made-up
// bearers at the door are in `api-2-agent-credential-door.test.ts`.

import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { comment, issued, latch, wordsOf, type Api } from './api-2-agent-credential-use-world.ts';
import { codesOf, limited, readWith, WIDE } from './api-2-agent-credential-quota-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
const READ_ONLY = { scope: [{ collection: 'task', action: 'read' }] };

function expectClearRefusal(answer: Answer | undefined, secret: string): void {
  expect(answer?.status).toBe(429);
  expect(answer?.code).toBe('AGENT_QUOTA_EXCEEDED');
  expect(wordsOf(answer as Answer)).toMatch(/wait/iu);
  expect(answer?.text).not.toContain(secret);
}

needsServer(
  'API-2 quota per credential: requests past the limit are refused under a burst, with a clear refusal',
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

/** A pool of its own, wide enough that a held call and the next are in flight at once. */
const widePool = () => connect(harness.world.db.appUrl, { source: 'runtime', max: 3 });

/**
 * `probe`'s answer, taken while a comment by `secret` is held in flight on the
 * task's row lock, and the comment's own answer once it is let go. The lock is
 * taken on a connection of its own, so the calls keep the pool, and it is let
 * go and closed on every path.
 */
async function whileHeld<T>(
  api: Api,
  secret: string,
  probe: () => Promise<T>,
): Promise<{ readonly probed: T; readonly held: Answer }> {
  const hold = latch();
  const locked = latch();
  const own = connect(harness.world.db.appUrl, { source: 'runtime', max: 1 });
  const holding = own.withBusiness(harness.world.alpha, async (tx) => {
    await tx.query('select id from public.records where id = $1 for update', [
      harness.alphaTask.id,
    ]);
    locked.open();
    await hold.promise;
  });
  let done: Promise<Answer>;
  let probed: T;
  try {
    // A failed lock query ends the wait here, not at the test's timeout.
    await Promise.race([locked.promise, holding]);
    done = comment(bearer(secret), api);
    // Read below; this only keeps an early failure from being reported unhandled.
    done.catch(() => {});
    // Long enough for the comment to be let in and reach the lock.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    probed = await probe();
  } finally {
    hold.open();
    await holding.finally(async () => await own.close());
  }
  return { probed, held: await done };
}

needsServer(
  'API-2 quota in flight per credential: a call past the limit is refused at once',
  async () => {
    const pool = widePool();
    try {
      const { api } = limited({ concurrent: { ...WIDE, credential: 1 } }, pool);
      const credential = await issued();
      const { probed, held } = await whileHeld(
        api,
        credential.secret,
        async () => await readWith(api, credential.secret),
      );
      expectClearRefusal(probed, credential.secret);
      expect(held.code, 'the held comment').toBe('ok');
      expect((await readWith(api, credential.secret)).code, 'its slot is back').toBe('ok');
    } finally {
      await pool.close();
    }
  },
);

needsServer(
  'API-2 quota in flight per person: a second credential of the same person is refused while the first is in flight',
  async () => {
    const pool = widePool();
    try {
      const { api } = limited({ concurrent: { ...WIDE, person: 1 } }, pool);
      const [first, second] = [await issued(), await issued()];
      const noahs = await issued(READ_ONLY, harness.world.noah.token);
      const { probed, held } = await whileHeld(api, first.secret, async () => [
        await readWith(api, second.secret),
        await readWith(api, noahs.secret),
      ]);
      expectClearRefusal(probed[0], second.secret);
      expect(probed[1]?.code, 'another person is outside it').toBe('ok');
      expect(held.code, 'the held comment').toBe('ok');
      expect((await readWith(api, second.secret)).code, 'its slot is back').toBe('ok');
    } finally {
      await pool.close();
    }
  },
);

needsServer(
  'API-2 quota in flight per business: another person’s credential is refused while the business is at its limit',
  async () => {
    const pool = widePool();
    try {
      const { api } = limited({ concurrent: { ...WIDE, business: 1 } }, pool);
      const adas = await issued();
      const noahs = await issued(READ_ONLY, harness.world.noah.token);
      const { probed, held } = await whileHeld(
        api,
        adas.secret,
        async () => await readWith(api, noahs.secret),
      );
      expectClearRefusal(probed, noahs.secret);
      expect(held.code, 'the held comment').toBe('ok');
      expect((await readWith(api, noahs.secret)).code, 'its slot is back').toBe('ok');
    } finally {
      await pool.close();
    }
  },
);

needsServer(
  'API-2 quota on export per credential: records handed out past the limit are refused',
  async () => {
    const { api } = limited({ exports: { ...WIDE, credential: 2 } });
    const credential = await issued();
    expect((await readWith(api, credential.secret)).code).toBe('ok');
    expect((await readWith(api, credential.secret)).code).toBe('ok');
    expectClearRefusal(await readWith(api, credential.secret), credential.secret);
  },
);

needsServer(
  'API-2 quota on export per person: two credentials of one person share its limit',
  async () => {
    const { api } = limited({ exports: { ...WIDE, person: 2 } });
    const [first, second] = [await issued(), await issued()];
    expect((await readWith(api, first.secret)).code).toBe('ok');
    expect((await readWith(api, second.secret)).code).toBe('ok');
    expectClearRefusal(await readWith(api, first.secret), first.secret);
    const noahs = await issued(READ_ONLY, harness.world.noah.token);
    expect((await readWith(api, noahs.secret)).code, 'another person is outside it').toBe('ok');
  },
);

needsServer(
  'API-2 quota on export per business: two people’s credentials share the business’s limit',
  async () => {
    const { api } = limited({ exports: { ...WIDE, business: 2 } });
    const adas = await issued();
    const noahs = await issued(READ_ONLY, harness.world.noah.token);
    expect((await readWith(api, adas.secret)).code).toBe('ok');
    expect((await readWith(api, noahs.secret)).code).toBe('ok');
    expectClearRefusal(await readWith(api, adas.secret), adas.secret);
  },
);
