// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, the delivery worker's standing: a pass chooses whom to try under an
// active worker, and each send reads the worker again in its own transaction
// before anything is asked of custody. A worker deactivated after the pass
// chose its targets, before the first send, asks for nothing and sends nothing.
//
// The send holds the worker `for share` until its transaction commits, and
// custody is asked only after that commit: a deactivation waits for a send
// already holding the worker, which goes out, and a send behind a
// deactivation in flight waits for it and sends nothing. A daily pass whose
// worker is deactivated between two people's batches sends the second none.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { deliverDue } from '../../packages/core-custody/src/index.ts';
import type { Database, TransactionQuery } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import {
  extra,
  freshInbox,
  heldOpen,
  stillWaiting,
  timing,
  useTimingWorld,
} from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

/** A promise and the call that settles it. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The app database, pausing after its `nth` transaction until `resume`. */
function pausedAfter(nth: number, reached: () => void, resume: Promise<void>): Database {
  let count = 0;
  return {
    ...w.db.app,
    withBusiness: async (business, run) => {
      const result = await w.db.app.withBusiness(business, run);
      count += 1;
      if (count === nth) {
        reached();
        await resume;
      }
      return result;
    },
  };
}

/** The app database, pausing in the first send's transaction once it has read the worker. */
function pausedHoldingWorker(held: () => void, resume: Promise<void>): Database {
  let count = 0;
  return {
    ...w.db.app,
    withBusiness: async (business, run) => {
      count += 1;
      if (count !== 2) return await w.db.app.withBusiness(business, run);
      return await w.db.app.withBusiness(business, async (tx) => {
        const holding: TransactionQuery = {
          ...tx,
          query: async <Row>(text: string, parameters?: readonly unknown[]) => {
            const rows = await tx.query<Row>(text, parameters);
            if (/kind = 'worker' and active/u.test(text)) {
              held();
              await resume;
            }
            return rows;
          },
        };
        return await run(holding);
      });
    },
  };
}

const DEACTIVATE =
  'update public.actors set active = false, deactivated_at = clock_timestamp() where business_id = $1 and id = $2';

/** A new active worker actor in the first business. */
async function newWorker(): Promise<string> {
  const actor = randomUUID();
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'worker', null)",
      [tx.businessId, actor],
    );
  });
  return actor;
}

it('AW-07b delivery worker: deactivated after the pass chose its targets, it starts no send', async () => {
  await freshInbox();
  const actor = await newWorker();
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const selected = signal();
  const resume = signal();
  const delayed = pausedAfter(1, selected.resolve, resume.promise);
  const pass = deliverDue(delayed, w.alpha, actor, timing(), 'at_once');
  try {
    await selected.promise;
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await tx.query(DEACTIVATE, [tx.businessId, actor]);
    });
  } finally {
    resume.resolve();
    await pass;
  }
  expect(await pass).toEqual({ ok: false, code: 'WORKER_REQUIRED' });
  expect(w.provider.outbox.length).toBe(before);
  expect(await attemptsOf(item)).toEqual([]);
});

it('AW-07b delivery worker: a deactivation waits for a send already holding the worker, which goes out', async () => {
  await freshInbox();
  const actor = await newWorker();
  await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const held = signal();
  const resume = signal();
  const pass = deliverDue(
    pausedHoldingWorker(held.resolve, resume.promise),
    w.alpha,
    actor,
    timing(),
    'at_once',
  );
  // Its own pool: the world's holds one connection, which the paused send has.
  const other = connect(w.db.appUrl, { source: 'runtime' });
  let deactivation: Promise<void> | undefined;
  let waited = false;
  try {
    await held.promise;
    deactivation = other.withBusiness(w.alpha, async (tx) => {
      await tx.query(DEACTIVATE, [tx.businessId, actor]);
    });
    waited = await stillWaiting(deactivation);
  } finally {
    resume.resolve();
    await pass;
    await deactivation;
    await other.close();
  }
  expect({ waited, pass: await pass, sent: w.provider.outbox.length - before }).toEqual({
    waited: true,
    pass: { ok: true, emails: 1 },
    sent: 1,
  });
});

it('AW-07b delivery worker: a send behind a deactivation in flight waits for it and sends nothing', async () => {
  await freshInbox();
  const actor = await newWorker();
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const selected = signal();
  const resume = signal();
  const pass = deliverDue(
    pausedAfter(1, selected.resolve, resume.promise),
    w.alpha,
    actor,
    timing(),
    'at_once',
  );
  await selected.promise;
  const deactivation = await heldOpen(async (tx) => {
    await tx.query(DEACTIVATE, [tx.businessId, actor]);
  });
  let waited = false;
  try {
    resume.resolve();
    waited = await stillWaiting(pass);
  } finally {
    await deactivation.release();
  }
  expect({
    waited,
    pass: await pass,
    sent: w.provider.outbox.length - before,
    attempts: await attemptsOf(item),
  }).toEqual({ waited: true, pass: { ok: false, code: 'WORKER_REQUIRED' }, sent: 0, attempts: [] });
});

it("AW-07b delivery worker: deactivated between two people's daily batches, it sends the second none", async () => {
  await freshInbox();
  const actor = await newWorker();
  await itemFor(w.task, 'mention');
  const second = await itemFor(w.task, 'mention', { id: w.alpha, person: extra.clientA2 });
  const before = w.provider.outbox.length;
  const firstSent = signal();
  const resume = signal();
  // The pass's own transaction, then the first batch's ask and its record.
  const pass = deliverDue(
    pausedAfter(3, firstSent.resolve, resume.promise),
    w.alpha,
    actor,
    timing(),
    'daily',
  );
  try {
    await firstSent.promise;
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await tx.query(DEACTIVATE, [tx.businessId, actor]);
    });
  } finally {
    resume.resolve();
    await pass;
  }
  expect({
    pass: await pass,
    sent: w.provider.outbox.length - before,
    second: await attemptsOf(second),
  }).toEqual({ pass: { ok: false, code: 'WORKER_REQUIRED' }, sent: 1, second: [] });
});
