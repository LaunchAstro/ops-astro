// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P13 (design v3, "P13 protocol"): the bind reads the ledger after its
// lock wait. The read and the bind both lock the lease row `for update`, so a
// bind waits behind an open read. Connection A runs the read's ledger write
// (`readPinned`, as the handler runs it) in a transaction held open;
// connection B sends the [definition, task] turn through the real door,
// naming A's read, and is seen parked on the lease. A commits: B binds and
// settles. On a fresh run, A rolls back: B is refused `PROVENANCE_UNBOUND`
// before any hold. Each case has its own run.

import { describe, expect, it } from 'vitest';
import { readPinned } from '../../packages/core-runtime/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { sourceOf } from '../runtime/aw-02-world.ts';
import { barrier, racer } from '../runtime/schedules-harness.ts';
import { leaseOf, parkedUnlessAnswered, s, signedIn } from './run-stop-door-world.ts';
import {
  bytesOf,
  definitionPart,
  ENTRY,
  pinnedWork,
  useDefinitionWorld,
  type Pinned,
} from './definition-world.ts';
import {
  beforeTurn,
  refusedBeforeAnyHold,
  sendTurn,
  settledOnce,
  type Sent,
} from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

const ROLLED_BACK = 'the read rolled back on purpose';

/** A holds the read open while B's turn waits on the lease; then A ends as `ending` says. */
async function turnBehindAnOpenRead(on: Pinned, ending: 'commit' | 'rollback'): Promise<Sent> {
  const as = await signedIn();
  const a = racer(s);
  const recorded = barrier();
  const gate = barrier();
  const reading = a.withBusiness(s.business, async (tx) => {
    const done = await readPinned(
      tx,
      {
        leaseId: leaseOf(on.work),
        holderActorId: s.agentActorId,
        runId: on.runId,
        stepId: on.stepId,
        path: ENTRY,
      },
      sourceOf(new Map([[ENTRY, bytesOf(ENTRY)]])),
      async () => {
        await Promise.resolve();
      },
    );
    if (!done.ok) throw new Error(`setup: the read was refused ${done.refusal.code}`);
    recorded.release();
    await gate.held;
    if (ending === 'rollback') throw new Error(ROLLED_BACK);
  });
  try {
    await Promise.race([recorded.held, reading]);
    const turning = sendTurn(on, [definitionPart(ENTRY), await taskPart(on.work)], as);
    expect(await parkedUnlessAnswered(turning, 'leases', 1), 'B waits on the lease').toBe(true);
    gate.release();
    await reading.catch((error: unknown) => {
      if (!String(error).includes(ROLLED_BACK)) throw error;
    });
    return await turning;
  } finally {
    gate.release();
    await a.close();
  }
}

describe.skipIf(serverUrl === undefined)('a turn waiting on an open definition read', () => {
  useDefinitionWorld('deflockwait');

  it('1: binds and settles once the read commits', async () => {
    const on = await pinnedWork('definition bind after the read commits');
    // Mutation: the ledger lookup ahead of `lockFacts`, or in a snapshot before the wait -> refused, red.
    settledOnce(await turnBehindAnOpenRead(on, 'commit'));
  }, 60_000);

  it('2: on a fresh run, is refused PROVENANCE_UNBOUND before any hold if the read rolls back', async () => {
    const on = await pinnedWork('definition bind after the read rolls back');
    const before = await beforeTurn(on);
    // Mutation: skip the ledger lookup (bind on the hash alone) -> binds, red.
    await refusedBeforeAnyHold(
      on,
      await turnBehindAnOpenRead(on, 'rollback'),
      'PROVENANCE_UNBOUND',
      before,
    );
  }, 60_000);
});
