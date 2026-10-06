// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 on the effect register, the edges a security review found: a revert
// whose answer never reached the register is never sent blind again, an entry
// from another business is never this correction's effect, and an entry under
// the right identity with a token the publish never sent is not its
// acceptance. Every provider here is a double: nothing reaches a live system.

import { describe, expect, it } from 'vitest';
import { doubles } from './c80-runner-doubles.ts';
import { runLivePublish } from '../../packages/core-commands/src/index.ts';
import { dispatchToken } from '../../packages/core-connectors/src/index.ts';
import { waitPast } from '../runtime/schedules-harness.ts';
import {
  RECEIPTS,
  countOf,
  describeWorld,
  filed,
  lows,
  stateOf as lowsState,
} from './live-correction-lows.ts';
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

describe.skipIf(serverUrl === undefined)('C80 revert runner', () => {
  it('reverts a live correction forward, observed and timed, with its receipt', async () => {
    const id = await approved();
    const ports = doubles();
    await publish(id, ports);
    expect(await revert(id, ports)).toMatchObject({ kind: 'recorded', state: 'reverted' });
    expect([ports.seen.reverted, await w.receiptsOf(id)]).toEqual([1, 4]);
    const observed = await receipt(id, 'revert');
    expect(observed['published_revision']).toEqual({ observed: 'rev-3' });
    expect(Number(observed['revert_interval_ms']?.observed)).toBeGreaterThan(0);
  });

  it('refuses to revert a correction that is not live, sending nothing', async () => {
    const id = await approved();
    const ports = doubles();
    expect(await revert(id, ports)).toEqual({ kind: 'refused', code: 'GATE_NOT_APPROVED' });
    expect([ports.seen.reverted, await w.receiptsOf(id)]).toEqual([0, 0]);
  });

  it('refuses to revert a publish accepted but not yet served, sending nothing', async () => {
    const id = await approved();
    const ports = doubles({
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served: false } }),
    });
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'accepted' });
    expect(await revert(id, ports)).toEqual({ kind: 'refused', code: 'GATE_NOT_APPROVED' });
    expect([ports.seen.reverted, await w.stateOf(id)]).toEqual([0, 'accepted']);
  });

  it('keeps the page live when the revert is accepted but not yet observed', async () => {
    const id = await approved();
    const ports = doubles();
    await publish(id, ports);
    const pending = doubles({
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served: true } }),
    });
    expect(await revert(id, pending)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(await w.receiptsOf(id)).toBe(4);
  });
});

describe.skipIf(serverUrl === undefined)('C80 runner on the effect register, cancelled', () => {
  it('observes a registered publish whose decided correction was cancelled, sending nothing', async () => {
    const id = await approved();
    const token = dispatchToken('site.publish', await versionOf(id));
    const correction = { id, taskId: lease.taskId };
    const answer = { revision: 'rev-2', deploymentId: 'dep-2', dispatchToken: token };
    expect(
      await registerCorrectionEffect(w.world.db.app, at(id), correction, 'publish', answer),
    ).toBe(true);
    await w.world.db.admin.execute(
      `update public.live_corrections set state = 'cancelled' where id = $1`,
      [id],
    );
    const ports = doubles();
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'unknown' });
    expect([ports.seen.dispatched.length, ports.seen.sourceReads]).toEqual([0, 0]);
    expect((await receipt(id, 'publish'))['published_revision']).toEqual({ observed: 'rev-2' });
  });
});

async function versionOf(id: string): Promise<string> {
  const [row] = await w.world.db.admin.execute<{ readonly v: string }>(
    'select version_digest as v from public.live_corrections where id = $1',
    [id],
  );
  return row?.v ?? '';
}

// A delegated worker whose delegating person lost the write it draws on: the read under the
// lease answers DELEGATION_NARROWED, and the run waits on that person, touching nothing.
describeWorld('C80 publish runner, a narrowed delegation', 'c80narrow', () => {
  it('waits on a person when the delegation narrowed, reading and sending nothing', async () => {
    const { s, leaseId, fence } = lows();
    const { id } = await filed('approved');
    const expired = await s.db.admin.execute<{ readonly id: string }>(
      `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection in ('task', 'run') and action = 'write'
          and revoked_at is null returning id`,
      [s.business, s.decider.personId],
    );
    expect(expired.length).toBeGreaterThan(0);
    await waitPast(
      s,
      'select max(expires_at) from public.grants where id = any($1::uuid[])',
      expired.map((grant) => grant.id),
    );
    const ports = doubles();
    const position = {
      business: s.business,
      correctionId: id,
      leaseId,
      fence,
      actorId: s.agentActorId,
    };
    expect(await runLivePublish(s.db.app, position, ports)).toEqual({
      kind: 'refused',
      code: 'DELEGATION_NARROWED',
      waitsOn: 'person',
    });
    expect(ports.seen.raised).toEqual(['DELEGATION_NARROWED']);
    expect([ports.seen.sourceReads, ports.seen.dispatched.length]).toEqual([0, 0]);
    expect([await lowsState(id), await countOf(RECEIPTS, id)]).toEqual(['approved', 0]);
  });
});
