// SPDX-License-Identifier: AGPL-3.0-only
//
// The one pickup-replay binding step both entries take (THERMO-RECHECK-2
// NNA2, `pickupReceiptBinding` in `pickup-receipt.ts`), against a real stored
// agent pickup receipt. The lease is bound to the delegation the caller
// replays under: its own delegation releases the receipt with that
// delegation's credential columns; no delegation (the person envelope's
// question), another agent's delegation or another holder releases nothing.
// Both paths carried this binding as a separate copy of the statement, and no
// suite reached it, because the holder check already separates a person's
// lease from an agent's.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { createIdentWorld, type IdentWorld, type Picked } from '../acceptance/ident-audit-cases.ts';
import { pickupReceiptBinding } from '../../packages/core-records/src/commands/pickup-receipt.ts';

describe.skipIf(serverUrl === undefined)('pickup receipt binding (NNA2)', () => {
  let w: IdentWorld;
  let own: Picked;
  let receipt: Readonly<Record<string, unknown>>;

  beforeAll(async () => {
    w = await createIdentWorld('pickup_receipt_binding');
    own = await w.pickUp(w.h.world.agent, 'a pickup whose receipt is replayed');
    const rows = await w.h.world.db.admin.execute<{ readonly result: Record<string, unknown> }>(
      `select result from public.operations
        where business_id = $1 and command = 'task.pickup' and actor_id = $2
          and result->'detail'->>'leaseId' = $3`,
      [w.h.world.alpha, w.h.world.agent.actorId, own.leaseId],
    );
    const detail = rows[0]?.result['detail'];
    if (typeof detail !== 'object' || detail === null) throw new Error('no stored pickup receipt');
    receipt = detail as Record<string, unknown>;
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const bind = async (holderActorId: string, delegationId: string | null) =>
    await w.h.world.db.app.withBusiness(
      w.h.world.alpha,
      async (tx) => await pickupReceiptBinding(tx, { holderActorId, delegationId, receipt }),
    );

  it('releases the receipt to its holder under its own delegation', async () => {
    const binding = await bind(w.h.world.agent.actorId, own.delegationId);
    expect('bound' in binding && binding.bound.credential_hash).toEqual(expect.any(String));
  });

  it('releases nothing under no delegation, another delegation or another holder', async () => {
    for (const [holder, delegation] of [
      [w.h.world.agent.actorId, null],
      [w.h.world.agent.actorId, w.otherPicked.delegationId],
      [w.h.world.ada.actorId as string, null],
      [w.h.world.ada.actorId as string, own.delegationId],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction at a time
      const binding = await bind(holder, delegation);
      expect('refusal' in binding && binding.refusal.code, `${holder} ${delegation}`).toBe(
        'LEASE_NOT_OWNED',
      );
    }
  });
});
