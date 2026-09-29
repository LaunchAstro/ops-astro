// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 publish runner and C80 revert runner: the system job that composes the
// reviewed executable with the records. It reads the approved correction under
// the worker lease, rebuilds the exact approved bytes from the pinned source,
// dispatches once, observes, and writes the observed result with its receipt
// under the same lease. Every provider here is a double: nothing reaches a
// live system.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { BEFORE, PAGE, c80World, type C80World } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import {
  runLivePublish,
  runLiveRevert,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';
import { dispatchToken } from '../../packages/core-connectors/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C80 runner: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
let lease: { leaseId: string; fence: number; taskId: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80run');
  await w.setApprover(w.ben.personId);
  const picked = await w.world.pickUp(w.cal, 'publish the About correction');
  const rows = await w.world.db.admin.execute<{ readonly id: string; readonly fence: string }>(
    `select id, fence::text as fence from public.leases where task_id = $1 and state = 'live'`,
    [picked.taskId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no live lease after pickup');
  lease = { leaseId: row.id, fence: Number(row.fence), taskId: picked.taskId };
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

async function correction(approved: boolean): Promise<string> {
  const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId }));
  const id = String(detail['correctionId']);
  if (approved)
    expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  return id;
}

const run = { correctionId: '', leaseId: '', fence: 0 };
const at = (correctionId: string, fence = lease.fence) => ({
  ...run,
  business: w.world.business,
  correctionId,
  leaseId: lease.leaseId,
  fence,
});
const publish = async (id: string, ports: RunnerPorts, fence?: number) =>
  await runLivePublish(w.world.db.app, at(id, fence), ports);
const revert = async (id: string, ports: RunnerPorts) =>
  await runLiveRevert(w.world.db.app, at(id), ports);

async function receipt(id: string, step: string): Promise<Record<string, { observed: string }>> {
  const rows = await w.world.db.admin.execute<{ readonly o: Record<string, { observed: string }> }>(
    `select observations as o from public.live_correction_receipts
      where correction_id = $1 and step = $2 order by created_at desc limit 1`,
    [id, step],
  );
  return rows[0]?.o ?? {};
}

async function digests(id: string): Promise<{ version: string; decided: string | null }> {
  const rows = await w.world.db.admin.execute<{ version: string; decided: string | null }>(
    `select version_digest as version, decided_version_digest as decided
       from public.live_corrections where id = $1`,
    [id],
  );
  return rows[0] ?? { version: '', decided: null };
}

describe.skipIf(serverUrl === undefined)('C80 publish runner', () => {
  it('publishes the approved bytes once and records live with its receipt', async () => {
    const id = await correction(true);
    const ports = doubles();
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'live' });
    const { version } = await digests(id);
    expect(ports.seen.dispatched).toEqual([
      {
        seam: expect.any(String),
        dispatchToken: dispatchToken('site.publish', version),
        versionDigest: version,
      },
    ]);
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['live', 1]);
    const observed = await receipt(id, 'publish');
    expect(observed['approved_version_digest']).toEqual({ observed: version });
    expect(observed['published_revision']).toEqual({ observed: 'rev-2' });
  });

  it('captures the correction page, never the address the provider answered with', async () => {
    const id = await correction(true);
    const ports = doubles();
    await publish(id, ports);
    expect(ports.seen.captured).toEqual([PAGE]);
    expect((await receipt(id, 'publish'))['post_live_address']).toEqual({ observed: PAGE });
  });

  it('records the digest the decision approved, and the storage keeps it the version', async () => {
    const id = await correction(true);
    const { version, decided } = await digests(id);
    expect(decided).toBe(version);
    await expect(
      w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query(
          `update public.live_corrections set decided_version_digest = 'sha256:other' where id = $1`,
          [id],
        );
      }),
    ).rejects.toThrow(/live_corrections_decided_version/u);
  });
});

describe.skipIf(serverUrl === undefined)('C80 publish runner, refusals before dispatch', () => {
  it('refuses a correction nobody approved, reading and sending nothing', async () => {
    const id = await correction(false);
    let read = 0;
    const ports = doubles({
      readSource: () => {
        read += 1;
        return Promise.resolve({ kind: 'ok', value: { content: BEFORE, revision: 'rev-1' } });
      },
    });
    expect(await publish(id, ports)).toEqual({ kind: 'refused', code: 'APPROVAL_MISSING' });
    expect([read, ports.seen.dispatched.length]).toEqual([0, 0]);
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['requested', 0]);
  });

  it('refuses drifted source as a wait on a person, never publishing the newer bytes', async () => {
    const id = await correction(true);
    const drifted = BEFORE.replace('decoy', 'changed');
    const ports = doubles({
      readSource: () =>
        Promise.resolve({ kind: 'ok', value: { content: drifted, revision: 'rev-9' } }),
    });
    expect(await publish(id, ports)).toEqual({
      kind: 'refused',
      code: 'CONTENT_DRIFTED',
      waitsOn: 'person',
    });
    expect(ports.seen.dispatched).toEqual([]);
    expect(ports.seen.raised).toEqual(['CONTENT_DRIFTED']);
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['approved', 0]);
  });

  it('refuses at a stale fence before reading or sending anything', async () => {
    const id = await correction(true);
    const ports = doubles();
    expect(await publish(id, ports, lease.fence + 1)).toEqual({
      kind: 'refused',
      code: 'LEASE_NOT_OWNED',
    });
    expect([ports.seen.dispatched.length, await w.stateOf(id)]).toEqual([0, 'approved']);
  });
});

describe.skipIf(serverUrl === undefined)('C80 publish runner, crossings', () => {
  it('reaches nothing of another business, sending nothing', async () => {
    const id = await correction(true);
    const ports = doubles();
    const answer = await runLivePublish(w.world.db.app, { ...at(id), business: w.beta }, ports);
    expect(answer).toEqual({ kind: 'refused', code: 'NOT_FOUND' });
    expect([ports.seen.dispatched.length, await w.stateOf(id)]).toEqual([0, 'approved']);
  });

  it('refuses a lease held on another task, sending nothing', async () => {
    const detail = detailOf(await w.request(w.ava));
    const id = String(detail['correctionId']);
    await w.approve(w.ben, id, String(detail['versionId']));
    const ports = doubles();
    expect(await publish(id, ports)).toEqual({ kind: 'refused', code: 'LEASE_NOT_OWNED' });
    expect([ports.seen.dispatched.length, await w.stateOf(id)]).toEqual([0, 'approved']);
  });
});

describe.skipIf(serverUrl === undefined)('C80 publish runner, after the dispatch', () => {
  it('keeps an unreadable answer unknown, raises a task, and never dispatches again', async () => {
    const id = await correction(true);
    const ports = doubles({
      publish: (input) => {
        ports.seen.dispatched.push(input);
        return Promise.resolve({ kind: 'unknown', code: 'PROVIDER_TIMEOUT' });
      },
    });
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'unknown' });
    expect(ports.seen.raised).toEqual(['PROVIDER_TIMEOUT']);
    expect(await publish(id, ports)).toEqual({ kind: 'refused', code: 'OUTCOME_UNKNOWN' });
    expect([ports.seen.dispatched.length, await w.receiptsOf(id)]).toEqual([1, 1]);
  });

  it('records accepted until served, then observes live without a second dispatch', async () => {
    const id = await correction(true);
    let served = false;
    const ports = doubles({
      readDeployment: () => Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served } }),
    });
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'accepted' });
    served = true;
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect([ports.seen.dispatched.length, await w.receiptsOf(id)]).toEqual([1, 2]);
  });
});

describe.skipIf(serverUrl === undefined)('C80 publish runner, a lease lost mid-flight', () => {
  it('writes nothing when the lease is lost during the dispatch, and raises a task', async () => {
    const id = await correction(true);
    const ports = doubles({
      publish: async (input) => {
        ports.seen.dispatched.push(input);
        await w.world.db.admin.execute(
          `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
          [lease.leaseId],
        );
        return { kind: 'ok', value: { revision: 'rev-2', deploymentId: 'dep-2', liveUrl: PAGE } };
      },
    });
    try {
      expect(await publish(id, ports)).toEqual({
        kind: 'unrecorded',
        outcome: 'live',
        code: 'LEASE_NOT_OWNED',
      });
      expect(ports.seen.raised).toEqual(['RECEIPT_NOT_WRITTEN']);
      expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['approved', 0]);
    } finally {
      await w.world.db.admin.execute(
        `update public.leases set expires_at = now() + interval '1 hour' where id = $1`,
        [lease.leaseId],
      );
    }
  });
});

describe.skipIf(serverUrl === undefined)('C80 revert runner', () => {
  it('reverts a live correction forward, observed and timed, with its receipt', async () => {
    const id = await correction(true);
    const ports = doubles();
    await publish(id, ports);
    expect(await revert(id, ports)).toMatchObject({ kind: 'recorded', state: 'reverted' });
    expect([ports.seen.reverted, await w.receiptsOf(id)]).toEqual([1, 2]);
    const observed = await receipt(id, 'revert');
    expect(observed['published_revision']).toEqual({ observed: 'rev-3' });
    expect(Number(observed['revert_interval_ms']?.observed)).toBeGreaterThan(0);
  });

  it('refuses to revert a correction that is not live, sending nothing', async () => {
    const id = await correction(true);
    const ports = doubles();
    expect(await revert(id, ports)).toEqual({ kind: 'refused', code: 'GATE_NOT_APPROVED' });
    expect([ports.seen.reverted, await w.receiptsOf(id)]).toEqual([0, 0]);
  });

  it('refuses to revert a publish accepted but not yet served, sending nothing', async () => {
    const id = await correction(true);
    const ports = doubles({
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served: false } }),
    });
    expect(await publish(id, ports)).toMatchObject({ kind: 'recorded', state: 'accepted' });
    expect(await revert(id, ports)).toEqual({ kind: 'refused', code: 'GATE_NOT_APPROVED' });
    expect([ports.seen.reverted, await w.stateOf(id)]).toEqual([0, 'accepted']);
  });

  it('keeps the page live when the revert is accepted but not yet observed', async () => {
    const id = await correction(true);
    const ports = doubles();
    await publish(id, ports);
    const pending = doubles({
      readDeployment: () =>
        Promise.resolve({ kind: 'ok', value: { revision: 'rev-2', served: true } }),
    });
    expect(await revert(id, pending)).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(await w.receiptsOf(id)).toBe(2);
  });
});
