// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694's world for `live_correction.list` and `live_correction.receipts`: C80's
// command-layer world, one correction published under a person's own lease
// with a receipt whose live place is longer than the receipt text limit and
// carries a planted marker, and Hal, who holds `run:write` across the
// business and reads task B alone.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { recordObservedResult } from '../../packages/core-records/src/site/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';

export type Answer = Awaited<ReturnType<typeof executeRead>>;

export const code = (result: Answer): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';

/** The ids a list answered, in its order. */
export const listed = (result: Answer): readonly string[] =>
  'corrections' in result
    ? (result.corrections as readonly { readonly correctionId: string }[]).map(
        (c) => c.correctionId,
      )
    : [];

export const MARKER: string = `marker-${randomUUID()}`;
export const LONG: string = `${MARKER} ${'walk beside you '.repeat(800)}`;

export interface ReadsWorld {
  readonly w: C80World;
  readonly hal: Member;
  /** The published correction, its task and its one receipt. */
  readonly live: {
    readonly id: string;
    readonly versionId: string;
    readonly taskId: string;
    readonly receiptId: string;
  };
  listAs(member: Member, business?: string): Promise<Answer>;
  receiptsAs(member: Member, correctionId: unknown, business?: string): Promise<Answer>;
  requested(
    member: Member,
    overrides?: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly id: string; readonly versionId: string }>;
}

const ok = (result: Awaited<ReturnType<C80World['as']>>): Record<string, unknown> => {
  expect(codeOf(result)).toBe('not-a-refusal');
  return detailOf(result);
};

const requestedIn =
  (w: C80World) =>
  async (member: Member, overrides: Readonly<Record<string, unknown>> = {}) => {
    const detail = detailOf(await w.request(member, overrides));
    return { id: String(detail['correctionId']), versionId: String(detail['versionId']) };
  };

/** The lease Cal's own pickup of a fresh task under party A holds. */
async function pickedUp(w: C80World) {
  const created = await w.as(w.cal, { command: 'task.create', fields: { title: 'About' } });
  const task = created as unknown as { readonly recordId: string; readonly revision: number };
  const shared = await w.as(w.admin, {
    command: 'task.set_party',
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { client: w.partyA },
  });
  const proposed = ok(
    await w.as(w.cal, {
      command: 'task.propose',
      recordId: task.recordId,
      expectedRevision: Number((shared as unknown as { revision: number }).revision),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
  );
  const decided = ok(
    await w.as(w.cal, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved for the holder to work',
    }),
  );
  const picked = ok(
    await w.as(w.cal, { command: 'task.pickup', reservationId: decided['reservationId'] }),
  );
  return { taskId: task.recordId, leaseId: String(picked['leaseId']) };
}

/** A correction on a task Cal holds, approved by Ben, then observed live with `observations`; C35-X's Receipt proof publishes one too. */
export async function published(
  w: C80World,
  observations: Readonly<Record<string, unknown>>,
): Promise<ReadsWorld['live']> {
  const { taskId, leaseId } = await pickedUp(w);
  const [lease] = await w.world.db.admin.execute<{ fence: string; holder: string }>(
    'select fence::text as fence, holder_actor_id as holder from public.leases where id = $1',
    [leaseId],
  );
  if (lease === undefined) throw new Error('no lease');
  const asked = await requestedIn(w)(w.ava, { taskId });
  expect(codeOf(await w.approve(w.ben, asked.id, asked.versionId))).toBe('not-a-refusal');
  const written = await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) =>
      await recordObservedResult(tx, {
        correctionId: asked.id,
        leaseId,
        fence: Number(lease.fence),
        actorId: lease.holder,
        step: 'publish',
        outcome: 'live',
        observations,
      }),
  );
  if (!written.ok) throw new Error(`receipt refused ${written.code}`);
  return { ...asked, taskId, receiptId: written.receiptId };
}

export async function correctionReadsWorld(part: string): Promise<ReadsWorld> {
  const w = await c80World(part);
  await w.setApprover(w.ben.personId);
  const live = await published(w, {
    published_revision: { observed: 'commit-0123abc' },
    deployment_id: { observed: 'dpl_live1694' },
    // A place longer than the receipt text limit, in the runner's own `live_occurrence`
    // shape: no real place is this long (128 characters each side), so the cut is a guard.
    live_occurrence: {
      observed: JSON.stringify({
        left: `${LONG} `,
        right: ' you.',
        index: 0,
        observed: ['beside'],
      }),
    },
    refusals_raised: { observed: 'none recorded' },
  });
  const hal = await enrol(w.world.db.app, w.world.business, 'hal');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, hal, 'write', { kind: 'business', id: null }, false, 'run');
    await grantTo(tx, hal, 'read', { kind: 'record', id: w.taskB });
  });
  return {
    w,
    hal,
    live,
    requested: requestedIn(w),
    listAs: async (member, business = w.world.business) =>
      await executeRead(w.world.db.app, business, member.presented, {
        read: 'live_correction.list',
      }),
    receiptsAs: async (member, correctionId, business = w.world.business) =>
      await executeRead(w.world.db.app, business, member.presented, {
        read: 'live_correction.receipts',
        correctionId,
      }),
  };
}
