// SPDX-License-Identifier: AGPL-3.0-only
//
// `startOccurrenceRun` waits for the occurrence's lock, then asks whether its
// caller is an active worker. A fixture transaction
// holds the occurrence lock (another start of the same occurrence); the start
// is admitted on the live worker and parks on the lock; the worker is
// deactivated and commits; then the fixture lets go. The start must be refused
// `WORKER_REQUIRED` and write no run, task, pin or audit event.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  authorityFor,
  codeOf,
  footprint,
  insertWorker,
  noDatabase,
  start,
  useOccurrenceWorld,
  w,
} from './occurrence-run-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useOccurrenceWorld('workerdeactivated');

it('an occurrence run for a worker deactivated during the occurrence lock wait is refused, and writes nothing', async () => {
  const worker = await insertWorker(w.s);
  const occurrenceId = randomUUID();
  const before = await footprint();
  const starter = connect(w.s.db.appUrl);
  try {
    const occurrence = await hold(w.s.db.appUrl, w.s.business, async (tx) => {
      await advisoryLock(tx, `occurrence_run:${tx.businessId}:${occurrenceId}`);
    });
    let starting: ReturnType<typeof start> | undefined;
    try {
      starting = start(w.s, occurrenceId, authorityFor(w.s), worker, starter);
      await waitingOn(w.s.db.admin, 'advisory', 'pg_advisory_xact_lock');
      await w.s.db.admin.execute(
        `update public.actors set active = false, deactivated_at = now()
          where business_id = $1 and id = $2`,
        [w.s.business, worker],
      );
    } finally {
      await occurrence.letGo();
    }
    const result = await starting;
    expect({ code: codeOf(result), footprint: await footprint() }).toEqual({
      code: 'WORKER_REQUIRED',
      footprint: before,
    });
  } finally {
    await starter.close();
  }
});
