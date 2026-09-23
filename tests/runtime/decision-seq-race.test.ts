// SPDX-License-Identifier: AGPL-3.0-only
//
// G02 (b): two approvals that both fit, decided at once on two backends, on
// the one business decision chain.
//
// `schedules-w05.test.ts` meets the chain lock too, but its second approval
// loses on the cap, so only one decision row is written and the case asserts
// codes. Here both tasks have room: a third connection holds the chain lock
// (`locks.ts`, class `chain`, the lock `decide.ts` takes first, R10), each
// racer is started only once the one before it is seen parked on it, and the
// holder then lets go. Both decisions must land, with distinct consecutive
// `seq` after the decision already on the chain, each row's `prev_hash` the
// row before it's `hash`, and the chain verifying on the production read.
//
// Everything goes through the production command entry (`executeCommand`), as
// in `schedules-harness.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import { CHAIN_GENESIS } from '../../packages/core-runtime/src/signing.ts';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  approve,
  approveBody,
  asPerson,
  awaitParked,
  capCommitted,
  codeOf,
  createTask,
  openSchedules,
  propose,
  racer,
  reasonOf,
  rows,
  settle,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/decision-seq-race: DATABASE_URL is unset, so nothing below ran.');
}

const EACH = 2_000;
/** Room for the decision already on the chain and both racers, with more to spare. */
const CAP = EACH * 10;

interface ChainRow {
  readonly seq: string;
  readonly gate_id: string;
  readonly prev_hash: string;
  readonly hash: string;
}

/** Hold the business decision-chain lock on a connection of its own until released. */
async function holdChain(s: Schedules): Promise<{ release(): Promise<void> }> {
  const database = racer(s);
  let locked!: () => void;
  let letGo!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const done = database.withBusiness(s.business, async (tx) => {
    await acquire(tx, [{ lockClass: 'chain', id: 'gate_decisions' }]);
    locked();
    await gate;
  });
  await isLocked;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      letGo();
      await done;
      await database.close();
    },
  };
}

describe.skipIf(serverUrl === undefined)('G02 (b): two approvals racing on the chain', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('seqrace', CAP);
  }, 120_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('writes both, at distinct consecutive seq, each linked to the row before', async () => {
    // A decision already on the chain, so the racers link to a real head.
    const headTask = await createTask(s, 'the decision already on the chain');
    await approve(s, await propose(s, headTask, { maximumMinor: EACH }));

    const leftTask = await createTask(s, 'first approval');
    const left = await propose(s, leftTask, { maximumMinor: EACH });
    const rightTask = await createTask(s, 'second approval');
    const right = await propose(s, rightTask, { maximumMinor: EACH });

    const leftDb = racer(s);
    const rightDb = racer(s);
    const holder = await holdChain(s);
    let outcomes: readonly PromiseSettledResult<CommandResult>[] = [];
    let parkedPids: readonly number[] = [];
    try {
      const first = asPerson(s, approveBody(left), leftDb);
      await awaitParked(s, 'advisory', 1);
      const second = asPerson(s, approveBody(right), rightDb);
      await awaitParked(s, 'advisory', 2);
      parkedPids = (
        await rows<{ readonly pid: number }>(
          s,
          `select distinct a.pid
             from pg_stat_activity a
             join pg_locks l on l.pid = a.pid and l.locktype = 'advisory' and not l.granted
            where a.datname = current_database() and a.wait_event_type = 'Lock'`,
          [],
        )
      ).map((row) => Number(row.pid));
      await holder.release();
      outcomes = await settle([first, second]);
    } finally {
      await holder.release().catch(() => undefined);
      await leftDb.close();
      await rightDb.close();
    }

    // Two backends, both seen parked on the chain lock before it was let go.
    expect(new Set(parkedPids).size).toBe(2);
    for (const outcome of outcomes) expect(outcome.status, reasonOf(outcome)).toBe('fulfilled');
    expect(
      outcomes.map((outcome) => (outcome.status === 'fulfilled' ? codeOf(outcome.value) : '')),
    ).toStrictEqual(['applied', 'applied']);
    // Both had room, and both hold it.
    expect(await capCommitted(s)).toBe(EACH * 3);

    const chain = await rows<ChainRow>(
      s,
      `select seq::text as seq, gate_id, prev_hash, hash
         from public.gate_decisions where business_id = $1 order by seq`,
      [s.business],
    );
    expect(chain.map((row) => Number(row.seq))).toStrictEqual([1, 2, 3]);
    expect(new Set(chain.map((row) => row.hash)).size).toBe(3);
    expect(chain[0]?.prev_hash).toBe(CHAIN_GENESIS);
    for (let at = 1; at < chain.length; at += 1) {
      expect(chain[at]?.prev_hash, `seq ${String(at + 1)}`).toBe(chain[at - 1]?.hash);
    }
    // Queue order is grant order: the first racer parked is the first served.
    expect(chain.slice(1).map((row) => row.gate_id)).toStrictEqual([
      left['gateId'],
      right['gateId'],
    ]);

    // And the production read verifies the whole chain for each task.
    for (const taskId of [leftTask, rightTask]) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time on the pool of one
      const proposals = await s.db.app.withBusiness(
        s.business,
        async (tx) => await readTaskProposals(tx, taskId),
      );
      expect(proposals.flatMap((proposal) => proposal.decisions)).toHaveLength(1);
    }
  }, 120_000);
});
