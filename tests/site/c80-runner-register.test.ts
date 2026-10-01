// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 on the effect register: the runner's publish and revert ride main's
// operation register (T2c2), one idempotency and reconciliation mechanism in
// the product. The dispatch derives its identity from the correction and its
// step (`effectOperationId`) and the provider's acceptance is an applied
// register entry under it; a second run asks the register before it sends, so
// an accepted effect is observed again, never sent again, and an unknown one
// is reconciled through the register or waits on a person. Receipt L stays
// the observation record beside the entry, and the two agree. Every provider
// here is a double: nothing reaches a live system.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import {
  runLivePublish,
  runLiveRevert,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';
import {
  correctionEffectId,
  registerCorrectionEffect,
} from '../../packages/core-commands/src/commands/live-correction-effect.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 runner register: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
let lease: { leaseId: string; fence: number; taskId: string; holder: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80reg');
  await w.setApprover(w.ben.personId);
  const picked = await w.world.pickUp(w.cal, 'publish the About correction');
  const rows = await w.world.db.admin.execute<{
    readonly id: string;
    readonly fence: string;
    readonly holder: string;
  }>(
    `select id, fence::text as fence, holder_actor_id as holder
       from public.leases where task_id = $1 and state = 'live'`,
    [picked.taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no live lease after pickup');
  lease = { leaseId: row.id, fence: Number(row.fence), taskId: picked.taskId, holder: row.holder };
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

async function approved(): Promise<string> {
  const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId }));
  const id = String(detail['correctionId']);
  expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  return id;
}

const at = (correctionId: string, business = w.world.business) => ({
  business,
  correctionId,
  leaseId: lease.leaseId,
  fence: lease.fence,
});
const publish = async (id: string, ports: RunnerPorts) =>
  await runLivePublish(w.world.db.app, at(id), ports);
const revert = async (id: string, ports: RunnerPorts) =>
  await runLiveRevert(w.world.db.app, at(id), ports);

interface Entry {
  readonly operation_id: string;
  readonly command: string;
  readonly actor_id: string;
  readonly outcome: string;
  readonly detail: Record<string, string>;
}

/** The register's effect entries for one correction (not its request or decision). */
async function entries(id: string): Promise<readonly Entry[]> {
  return await w.world.db.admin.execute<Entry>(
    `select operation_id, command, actor_id, outcome, result -> 'detail' as detail
       from public.operations where record_id = $1 and command like 'site.%'
      order by created_at, id`,
    [id],
  );
}

async function receipt(id: string, step: string): Promise<Record<string, { observed: string }>> {
  const rows = await w.world.db.admin.execute<{ readonly o: Record<string, { observed: string }> }>(
    `select observations as o from public.live_correction_receipts
      where correction_id = $1 and step = $2 order by created_at desc, id desc limit 1`,
    [id, step],
  );
  return rows[0]?.o ?? {};
}

async function expireLease(): Promise<void> {
  await w.world.db.admin.execute(
    `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
    [lease.leaseId],
  );
}
async function renewLease(): Promise<void> {
  await w.world.db.admin.execute(
    `update public.leases set expires_at = now() + interval '1 hour' where id = $1`,
    [lease.leaseId],
  );
}

describe.skipIf(serverUrl === undefined)('C80 runner on the effect register', () => {
  it('registers the accepted publish under the identity derived from the correction', async () => {
    const id = await approved();
    expect(await publish(id, doubles())).toMatchObject({ kind: 'recorded', state: 'live' });
    const [entry, ...rest] = await entries(id);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      operation_id: effectOperationId(`${id}.publish`),
      command: 'site.publish',
      actor_id: lease.holder,
      outcome: 'applied',
    });
    expect(correctionEffectId(id, 'publish')).toBe(entry?.operation_id);
  });

  it('keeps the receipt and the register agreeing on the effect', async () => {
    const id = await approved();
    await publish(id, doubles());
    const [entry] = await entries(id);
    const observed = await receipt(id, 'publish');
    expect(observed['effect_operation_id']).toEqual({ observed: entry?.operation_id });
    expect(observed['published_revision']).toEqual({ observed: entry?.detail['revision'] });
    expect(observed['deployment_id']).toEqual({ observed: entry?.detail['deploymentId'] });
    expect(observed['attempt_and_dispatch_token']).toEqual({
      observed: entry?.detail['dispatchToken'],
    });
  });

  it('observes a publish accepted under a lost lease on the next run, never dispatching again', async () => {
    const id = await approved();
    const lost = doubles({
      publish: async (input) => {
        lost.seen.dispatched.push(input);
        await expireLease();
        return {
          kind: 'ok',
          value: { revision: 'rev-2', deploymentId: 'dep-2', liveUrl: 'x' },
        };
      },
    });
    try {
      expect(await publish(id, lost)).toMatchObject({ kind: 'unrecorded' });
    } finally {
      await renewLease();
    }
    expect([await w.stateOf(id), await w.receiptsOf(id), (await entries(id)).length]).toEqual([
      'approved',
      0,
      1,
    ]);
    const again = doubles();
    expect(await publish(id, again)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect([lost.seen.dispatched.length, again.seen.dispatched.length]).toEqual([1, 0]);
    expect([again.seen.sourceReads, await w.receiptsOf(id)]).toEqual([0, 1]);
  });

  it('observes an accepted publish again from the register entry, never dispatching again', async () => {
    const id = await approved();
    const asked: string[] = [];
    let served = false;
    const ports = doubles({
      readDeployment: (deploymentId) => {
        asked.push(deploymentId);
        return Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served } });
      },
    });
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'accepted' });
    served = true;
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect([ports.seen.dispatched.length, asked]).toEqual([1, ['dep-2', 'dep-2']]);
    expect((await entries(id)).length).toBe(1);
  });

  it('reconciles an unknown publish through the register: absent it waits, present it is observed', async () => {
    const id = await approved();
    const timeout = doubles({
      publish: (input) => {
        timeout.seen.dispatched.push(input);
        return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' });
      },
    });
    expect(await publish(id, timeout)).toMatchObject({ kind: 'recorded', state: 'unknown' });
    expect((await receipt(id, 'publish'))['effect_operation_id']).toEqual({
      observed: correctionEffectId(id, 'publish'),
    });
    expect(await entries(id)).toEqual([]);
    expect(await publish(id, timeout)).toEqual({ kind: 'refused', code: 'OUTCOME_UNKNOWN' });

    const correction = { id, taskId: lease.taskId };
    const answer = { revision: 'rev-2', deploymentId: 'dep-2', dispatchToken: 'sha256:late' };
    expect(
      await registerCorrectionEffect(w.world.db.app, at(id), correction, 'publish', answer),
    ).toBe(true);
    const later = doubles();
    expect(await publish(id, later)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect([timeout.seen.dispatched.length, later.seen.dispatched.length]).toEqual([1, 0]);
    expect((await receipt(id, 'publish'))['attempt_and_dispatch_token']).toEqual({
      observed: 'sha256:late',
    });
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['live', 2]);
  });

  it('writes one entry when the same effect is answered twice', async () => {
    const id = await approved();
    const correction = { id, taskId: lease.taskId };
    const answer = { revision: 'rev-2', deploymentId: 'dep-2', dispatchToken: 'sha256:one' };
    await registerCorrectionEffect(w.world.db.app, at(id), correction, 'publish', answer);
    await registerCorrectionEffect(w.world.db.app, at(id), correction, 'publish', {
      ...answer,
      revision: 'rev-other',
    });
    expect((await entries(id)).map((entry) => entry.detail['revision'])).toEqual(['rev-2']);
  });
});

describe.skipIf(serverUrl === undefined)('C80 revert on the effect register', () => {
  it('registers the accepted revert and observes it again on the next run, never sending twice', async () => {
    const id = await approved();
    await publish(id, doubles());
    const pending = doubles({
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served: true } }),
    });
    expect(await revert(id, pending)).toMatchObject({ kind: 'recorded', state: 'live' });
    const commands = (await entries(id)).map((entry) => entry.command);
    expect(commands).toEqual(['site.publish', 'site.revert']);
    const decidedAt = (await receipt(id, 'revert'))['decided_at'];
    // The site as the first revert left it: the page shows the original word.
    const later = doubles({}, pending.capture);
    expect(await revert(id, later)).toMatchObject({ kind: 'recorded', state: 'reverted' });
    expect([pending.seen.reverted, later.seen.reverted]).toEqual([1, 0]);
    const observed = await receipt(id, 'revert');
    expect(observed['decided_at']).toEqual(decidedAt);
    expect(observed['published_revision']).toEqual({ observed: 'rev-3' });
  });

  it('keeps an unknown revert waiting on a person, never sending it again', async () => {
    const id = await approved();
    await publish(id, doubles());
    const lost = doubles({
      revert: () => {
        lost.seen.reverted += 1;
        return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' });
      },
    });
    expect(await revert(id, lost)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(lost.seen.raised).toEqual(['PROVIDER_TIMEOUT']);
    expect(await revert(id, lost)).toEqual({ kind: 'refused', code: 'OUTCOME_UNKNOWN' });
    expect([lost.seen.reverted, await w.receiptsOf(id)]).toEqual([1, 2]);
  });
});

describe.skipIf(serverUrl === undefined)('C80 runner on the effect register, crossings', () => {
  it('takes no entry a member wrote under the same identity as the effect', async () => {
    const id = await approved();
    await w.world.db.admin.execute(
      `insert into public.operations
         (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
          record_id)
       values ($1, gen_random_uuid(), $2, 'site.publish', $3, repeat('a', 64), 'applied',
               '{"detail":{"revision":"rev-planted","deploymentId":"dep-planted"}}', $4)`,
      [w.world.business, correctionEffectId(id, 'publish'), w.ava.actorId, id],
    );
    const ports = doubles();
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(ports.seen.dispatched.length).toBe(1);
    expect((await receipt(id, 'publish'))['published_revision']).toEqual({ observed: 'rev-2' });
  });

  it('reaches no entry from another business, observing and sending nothing', async () => {
    const id = await approved();
    let served = false;
    const asked: string[] = [];
    const ports = doubles({
      readDeployment: (deploymentId) => {
        asked.push(deploymentId);
        return Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served } });
      },
    });
    await publish(id, ports);
    served = true;
    const answer = await runLivePublish(w.world.db.app, at(id, w.beta), ports);
    expect(answer).toEqual({ kind: 'refused', code: 'NOT_FOUND' });
    expect([asked.length, ports.seen.dispatched.length, await w.stateOf(id)]).toEqual([
      1,
      1,
      'accepted',
    ]);
  });

  it('registers nothing under a lease of another task', async () => {
    const id = await approved();
    const other = { id, taskId: w.taskA };
    expect(
      await registerCorrectionEffect(w.world.db.app, at(id), other, 'publish', {
        revision: 'rev-x',
        deploymentId: 'dep-x',
      }),
    ).toBe(false);
    expect(await entries(id)).toEqual([]);
  });
});
