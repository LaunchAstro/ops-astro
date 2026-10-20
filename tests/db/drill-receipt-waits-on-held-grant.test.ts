// SPDX-License-Identifier: AGPL-3.0-only
//
// A drill's receipt in the store and the tested-restore stamp are written
// under the operator's held grant, after the gate is asked again under that
// hold (drill-acts.mjs, `attested`). That answer is the instant the operator
// attests:
//
// - a revocation of `operations:manage` committed after the drill's last part
//   was read and before the receipt is refused there: no `backups.drills` row
//   and no change to `ops.last_tested_restore`, on the machine and on
//   `--record`;
// - a revocation started once the hold is taken waits on it, and commits only
//   after the stamp has.
//
// The store is the store suites' own (backup-identity.fixture.ts), whose
// appointment names their made-up operator, so the gate faces the store as
// that operator. The asks, the hold and the stamp are the installation's real
// gate (operator.ts) for a signed-in operator on a database of its own
// (operator-only.fixture.ts), whose grant each case revokes. The revocation
// cases call the acts in drill-acts.mjs with a store route that asks nothing
// of its own, so what refuses is the act, not the route.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import { adminUrl, operatorOnlyHooks, serverUrl, subjects } from '../ci/operator-only.fixture.ts';
import type { OperatorOnlyState } from '../ci/operator-only.fixture.ts';
import { load, signedIn } from '../ci/s0-3e-operating-business.fixture.ts';
import {
  addArchive,
  asRole,
  BACKUP,
  backupLogin,
  backupStoreHooks,
  Client,
  hostReach,
  operatorLogin,
  OPERATING_BUSINESS,
  store,
  type Reach,
} from './backup-identity.fixture.ts';
import {
  carriedBack,
  carriedReceipt,
  exportedFile,
  operator,
  scratch,
} from './backup-carried.fixture.ts';
import { passed } from './backup-drill-records.fixture.ts';

type Act = (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Acts = { drillAsOperator: Act; recordCarried: Act };
type Gate = Record<string, unknown> & { recordTestedRestore: () => Promise<string> };
type Fetch = { fetchArchive: (into: string) => Promise<{ takenAt: string }> };

const REFUSED =
  /the drill ran, but the operator no longer holds operations:manage, so no receipt was written/u;
const GRANT = "subject_id = $1 and collection = 'operations' and action = 'manage'";

let state: OperatorOnlyState;

/**
 * Revokes the operator's grant and commits, on a session of its own so a
 * wait on a lock holds up nothing else here; it waits at most `wait`.
 */
async function revoke(wait = '5s'): Promise<void> {
  const session = new Client(adminUrl());
  try {
    await session.query('begin');
    await session.query(`set local lock_timeout = '${wait}'`);
    await session.query(`update public.grants set revoked_at = now() where ${GRANT}`, [
      state.operatorPerson,
    ]);
    await session.query('commit');
  } finally {
    await session.end();
  }
}

/** Whether a revocation of the grant is waiting on a lock now. */
async function revocationWaits(): Promise<boolean> {
  const [row] = await state.db.admin.execute<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update public.grants set revoked_at%'",
  );
  return row?.n === 1;
}

/** The real gate, admitted now, facing the store as the store's appointed operator. */
async function gate(): Promise<Gate> {
  const { env } = await signedIn(subjects.operator, 'alpha');
  const admitted = await requireOperatingOperator(env);
  if (!admitted.ok) throw new Error(admitted.reason);
  return { ...admitted, operator: { personId: operator, business: OPERATING_BUSINESS } };
}

/** What the cases compare: the store's drills and the stamp the operations view reads. */
async function written(): Promise<{ drills: number; stamp: string | null }> {
  const [drills] = await store.admin.execute<{ n: number }>(
    'select count(*)::int as n from backups.drills',
  );
  const [stamp] = await state.db.admin.execute<{ at: string }>(
    'select at::text as at from ops.last_tested_restore',
  );
  return { drills: drills?.n ?? 0, stamp: stamp?.at ?? null };
}

async function newArchive(): Promise<void> {
  const job = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(job, randomBytes(16));
  } finally {
    await job.end();
  }
}

/** A drill that fetches the newest archive, then runs `after`, then passes. */
const passing =
  (after: () => Promise<void>) =>
  async ({ fetchArchive }: Fetch): Promise<Record<string, unknown>> => {
    const fetched = await fetchArchive(join(mkdtempSync(join(scratch, 'fetch-')), 'archive'));
    await after();
    return {
      event: 'restore drill',
      at: new Date().toISOString(),
      ...passed,
      archiveTakenAt: fetched.takenAt,
    };
  };

/** Whether the act refused as the hold refuses, and what is written after it. */
const settled = async (
  run: Promise<unknown>,
): Promise<{ refused: boolean; said: string; written: Awaited<ReturnType<typeof written>> }> => {
  const said = await run.then(
    () => 'recorded',
    (error: Error) => error.message,
  );
  return { refused: REFUSED.test(said), said, written: await written() };
};

async function onTheMachineRevokedBeforeTheReceipt(): Promise<void> {
  await newArchive();
  const before = await written();
  const { drillAsOperator } = await load<Acts>('../../scripts/ops/drill-acts.mjs');
  const {
    refused,
    said,
    written: after,
  } = await settled(
    drillAsOperator({
      gate: await gate(),
      storeUrl: operatorLogin.url,
      privateKey: 'unused',
      scope: {},
      reach: hostReach,
      drill: passing(async () => await revoke()),
    }),
  );
  expect({ refused, written: after }).toStrictEqual({ refused: true, written: before });
  expect(said).not.toContain(operatorLogin.url);
}

async function onRecordRevokedBeforeTheReceipt(): Promise<void> {
  const receiptFile = carriedBack(await carriedReceipt());
  const admitted = await gate();
  await revoke();
  const before = await written();
  const { recordCarried } = await load<Acts>('../../scripts/ops/drill-acts.mjs');
  const { refused, written: after } = await settled(
    recordCarried({
      gate: admitted,
      storeUrl: operatorLogin.url,
      receiptFile,
      archiveFile: exportedFile(),
      reach: hostReach,
    }),
  );
  expect({ refused, written: after }).toStrictEqual({ refused: true, written: before });
}

/**
 * The store route, starting a revocation as the receipt's call reaches it,
 * once the drill has read the archive, and sending the receipt once that
 * revocation waits on a lock or has committed. `order` gets its commit.
 */
function revokingAtTheReceipt(order: string[]): {
  reach: Reach;
  revocation: () => Promise<void>;
  waited: () => boolean;
} {
  let [revocation, done, waited] = [Promise.resolve(), false, false];
  const reach: Reach = async (url, script, onLine) => {
    if (onLine === undefined && String(script).includes('backups.record_drill')) {
      revocation = (async () => {
        await revoke('30s');
        done = true;
        order.push('revocation committed');
      })();
      for (let tries = 0; tries < 250; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polled until it waits or commits
        waited = await revocationWaits();
        if (waited || done) break;
        // oxlint-disable-next-line no-await-in-loop
        await sleep(20);
      }
    }
    return await hostReach(url, script, onLine);
  };
  return { reach, revocation: () => revocation, waited: () => waited };
}

async function revocationDuringTheHoldWaitsForTheStamp(): Promise<void> {
  await newArchive();
  const before = await written();
  const order: string[] = [];
  const route = revokingAtTheReceipt(order);
  const admitted = await gate();
  const { drillAsOperator } = await load<Acts>('../../scripts/ops/restore-drill.mjs');
  const receipt = await drillAsOperator({
    gate: {
      ...admitted,
      recordTestedRestore: async () => {
        const at = await admitted.recordTestedRestore();
        order.push('stamp committed');
        return at;
      },
    },
    storeUrl: operatorLogin.url,
    privateKey: 'unused',
    scope: {},
    reach: route.reach,
    drill: passing(() => Promise.resolve()),
  });
  await route.revocation();
  const after = await written();
  expect({ waited: route.waited(), order, outcome: receipt['outcome'] }).toStrictEqual({
    waited: true,
    order: ['stamp committed', 'revocation committed'],
    outcome: 'passed',
  });
  expect(after.drills).toBe(before.drills + 1);
  expect(after.stamp).not.toBeNull();
}

describe.skipIf(serverUrl === undefined)("a drill's receipt and stamp under the held grant", () => {
  operatorOnlyHooks((shared) => {
    state = shared;
  });
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  // Each case starts with the operator holding the grant again.
  beforeEach(async () => {
    await state.db.admin.execute(`update public.grants set revoked_at = null where ${GRANT}`, [
      state.operatorPerson,
    ]);
  });

  it(
    'on the machine, a revocation after the last part is read and before the receipt writes no receipt and no stamp',
    onTheMachineRevokedBeforeTheReceipt,
  );
  it(
    'on --record, a revocation once the gate admitted and before the receipt writes no receipt and no stamp',
    onRecordRevokedBeforeTheReceipt,
  );
  it(
    'a revocation started while the hold is taken commits only after the stamp has',
    revocationDuringTheHoldWaitsForTheStamp,
  );
});
