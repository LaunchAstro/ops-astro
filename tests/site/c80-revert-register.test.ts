// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 on the effect register, the edges a security review found: a revert
// whose answer never reached the register is never sent blind again, an entry
// from another business is never this correction's effect, and an entry under
// the right identity with a token the publish never sent is not its
// acceptance. Every provider here is a double: nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import { doubles } from './c80-runner-doubles.ts';
import {
  correctionEffectId,
  registerCorrectionEffect,
} from '../../packages/core-commands/src/commands/live-correction-effect.ts';
import {
  approved,
  at,
  expireLease,
  lease,
  publish,
  receipt,
  renewLease,
  revert,
  serverUrl,
  useRegisterWorld,
  w,
} from './c80-register-world.ts';

useRegisterWorld();

/** A live correction, published through the doubles. */
async function live(): Promise<string> {
  const id = await approved();
  expect(await publish(id, doubles())).toMatchObject({ kind: 'recorded', state: 'live' });
  return id;
}

describe.skipIf(serverUrl === undefined)('C80 revert, an answer the register never held', () => {
  it('never sends again a revert left unknown when the lease was lost before its receipt', async () => {
    const id = await live();
    const lost = doubles({
      revert: async () => {
        lost.seen.reverted += 1;
        await expireLease();
        return { kind: 'unknown', code: 'PROVIDER_TIMEOUT' };
      },
    });
    try {
      expect(await revert(id, lost)).toMatchObject({ kind: 'unrecorded' });
      await renewLease();
      expect([await revert(id, lost), lost.seen.reverted]).toEqual([
        { kind: 'refused', code: 'OUTCOME_UNKNOWN' },
        1,
      ]);
    } finally {
      await renewLease();
    }
  });

  it('never sends again a revert whose answer was lost before it was registered', async () => {
    const id = await live();
    const crashed = doubles({
      revert: () => {
        crashed.seen.reverted += 1;
        if (crashed.seen.reverted === 1) throw new Error('worker lost after the provider answered');
        return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' });
      },
    });
    await expect(revert(id, crashed)).rejects.toThrow('worker lost');
    expect([await revert(id, crashed), crashed.seen.reverted]).toEqual([
      { kind: 'refused', code: 'OUTCOME_UNKNOWN' },
      1,
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('C80 publish, entries that are not the effect', () => {
  it('takes no entry another business holds under the same identity', async () => {
    const id = await approved();
    await w.world.db.admin.execute(
      `insert into public.operations
         (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
          record_id)
       values ($1, gen_random_uuid(), $2, 'site.publish', $3, repeat('b', 64), 'applied',
               '{"detail":{"revision":"rev-beta","deploymentId":"dep-beta",
                 "dispatchToken":"sha256:beta"}}', $4)`,
      [w.beta, correctionEffectId(id, 'publish'), w.eve.actorId, id],
    );
    const ports = doubles();
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(ports.seen.dispatched.length).toBe(1);
    expect((await receipt(id, 'publish'))['published_revision']).toEqual({ observed: 'rev-2' });
  });

  it('does not observe as accepted an entry whose token the publish never sent', async () => {
    const id = await approved();
    const correction = { id, taskId: lease.taskId };
    const answer = { revision: 'rev-2', deploymentId: 'dep-2', dispatchToken: 'sha256:other' };
    await registerCorrectionEffect(w.world.db.app, at(id), correction, 'publish', answer);
    const ports = doubles();
    expect(await publish(id, ports)).toEqual({ kind: 'refused', code: 'OUTCOME_UNKNOWN' });
    expect([ports.seen.dispatched.length, await w.stateOf(id), await w.receiptsOf(id)]).toEqual([
      0,
      'approved',
      0,
    ]);
  });
});
