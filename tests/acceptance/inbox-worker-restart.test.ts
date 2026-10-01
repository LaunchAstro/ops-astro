// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1g, the worker's leg (supporting checklist: "Inbox items read back
// identically after the API, the worker and the browser restart"; the API and
// browser legs are `tests/cli/inbox-readback.test.ts`). T2b's worker runs as
// its own process on a served API. It is hard-killed after its reservation:
// the launcher's inbox reads back identically. A replacement worker, started
// once the lease has run out, finds the run waiting on the API's recovery
// pass (T3d's) and stands idle, and the inbox still reads back identically.
//
// Asked only by the runtime proofs' runner (`restart-proof.sh` with
// L5_RUNTIME_PROOFS=1), on its own Postgres, as the T3d2 proofs are; CI's
// `local checks` runs it that way, and a skip there fails the step.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hardKill, until } from './kill-harness.ts';
import { openProofWorld, PROOFS_ASKED, type ProofWorld } from './proof-world.ts';

type Entry = Readonly<Record<string, unknown>>;

describe.skipIf(!PROOFS_ASKED)('INB-1 the inbox reads back after the worker restarts', () => {
  let p: ProofWorld;

  const inbox = async (): Promise<readonly Entry[]> =>
    (await p.asAda('inbox.read', {}))['inbox'] as Entry[];

  beforeAll(async () => {
    p = await openProofWorld('inb1_worker');
  }, 120_000);

  afterAll(async () => {
    await p?.close();
  }, 60_000);

  it('INB-1 inbox items read back identically after the worker restarts', async () => {
    await p.api('inb1-api');
    const w = await p.approvedWork(p.world.agent);
    const first = p.worker(w, 'after-reservation', 'inb1-worker-a', 20);
    expect(await first.parked()).toBe('after-reservation');
    const before = await inbox();
    expect(before.length).toBeGreaterThan(0);

    await hardKill('INB-1 worker', first, p.admin, 'inb1-api');
    expect(await inbox()).toStrictEqual(before);

    // Once the 20 s lease has run out, a replacement carries the run through.
    await until(
      async () =>
        (
          await p.admin.execute(
            `select 1 from public.leases
              where business_id = $1 and task_id = $2 and expires_at > now()`,
            [p.world.alpha, w.taskId],
          )
        ).length === 0,
      60_000,
    );
    const second = p.worker(w, 'none', 'inb1-worker-b', 20);
    expect(await second.exited()).toBeNull();

    // The replacement finds the run waiting on the API's recovery pass (T3d's)
    // and stands idle; the inbox is still exactly what it was.
    expect(second.lines().at(-1)).toBe(JSON.stringify({ idle: { taskId: w.taskId } }));
    expect(await inbox()).toStrictEqual(before);
  }, 180_000);
});
