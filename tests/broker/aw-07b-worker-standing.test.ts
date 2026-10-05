// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, the delivery worker's standing: a pass chooses whom to try under an
// active worker, and each send reads the worker again in its own transaction
// before anything is asked of custody. A worker deactivated after the pass
// chose its targets, before the first send, asks for nothing and sends nothing.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { deliverDue } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import { freshInbox, timing, useTimingWorld } from './email-timing-world.ts';

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

/** The app database, pausing after its first transaction until `resume`. */
function pausedAfterFirst(selected: () => void, resume: Promise<void>): Database {
  let first = true;
  return {
    ...w.db.app,
    withBusiness: async (business, run) => {
      const result = await w.db.app.withBusiness(business, run);
      if (first) {
        first = false;
        selected();
        await resume;
      }
      return result;
    },
  };
}

it('AW-07b delivery worker: deactivated after the pass chose its targets, it starts no send', async () => {
  await freshInbox();
  const actor = randomUUID();
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(
      "insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'worker', null)",
      [tx.businessId, actor],
    );
  });
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const selected = signal();
  const resume = signal();
  const delayed = pausedAfterFirst(selected.resolve, resume.promise);
  const pass = deliverDue(delayed, w.alpha, actor, timing(), 'at_once');
  try {
    await selected.promise;
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await tx.query(
        'update public.actors set active = false, deactivated_at = clock_timestamp() where business_id = $1 and id = $2',
        [tx.businessId, actor],
      );
    });
  } finally {
    resume.resolve();
    await pass;
  }
  expect(await pass).toEqual({ ok: false, code: 'WORKER_REQUIRED' });
  expect(w.provider.outbox.length).toBe(before);
  expect(await attemptsOf(item)).toEqual([]);
});
