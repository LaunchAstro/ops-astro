// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  checkDelegatedAuthority,
  resolveLiveById,
} from '../../packages/core-records/src/authority/delegations.ts';
import {
  readCorrectionForRun,
  recordObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import { waitPast } from '../runtime/schedules-harness.ts';
import {
  describeWorld,
  filed,
  inBusiness,
  lows,
  stateOf,
  countOf,
  RECEIPTS,
} from './live-correction-lows.ts';

async function expireWorkGrants(personId: string): Promise<void> {
  const { s } = lows();
  const expired = await s.db.admin.execute<{ readonly id: string }>(
    `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection in ('task', 'run') and action = 'write'
        and revoked_at is null returning id`,
    [s.business, personId],
  );
  expect(expired.length).toBeGreaterThan(0);
  await waitPast(
    s,
    'select max(expires_at) from public.grants where id = any($1::uuid[])',
    expired.map((grant) => grant.id),
  );
}

async function workerDelegation() {
  const { s, leaseId } = lows();
  const [lease] = await s.db.admin.execute<{ readonly delegation_id: string }>(
    'select delegation_id from public.leases where id = $1',
    [leaseId],
  );
  if (lease === undefined) throw new Error('the worker lease is missing');
  const delegation = await inBusiness(
    async (tx) => await resolveLiveById(tx, s.agentActorId, lease.delegation_id),
  );
  if (delegation === undefined) throw new Error('the worker delegation is missing');
  return delegation;
}

describeWorld(
  "delegated worker authority under the delegating person's grants",
  'workergrants',
  () => {
    it('person to person grant expiry stops a delegated worker correction read and receipt write', async () => {
      const { s, leaseId, fence, taskA } = lows();
      const { id } = await filed('approved');
      const at = { correctionId: id, leaseId, fence, actorId: s.agentActorId };
      const delegation = await workerDelegation();
      const request = {
        collection: 'run',
        action: 'write' as const,
        scope: { kind: 'record' as const, id: taskA },
      };
      expect(
        (await inBusiness(async (tx) => await checkDelegatedAuthority(tx, delegation, request))).ok,
      ).toBe(true);
      expect(await inBusiness(async (tx) => await readCorrectionForRun(tx, at))).toMatchObject({
        ok: true,
      });
      await expireWorkGrants(delegation.delegatePersonId);
      const standing = await inBusiness(
        async (tx) => await checkDelegatedAuthority(tx, delegation, request),
      );
      expect(standing).toMatchObject({ ok: false, refusal: { code: 'DELEGATION_NARROWED' } });
      const read = await inBusiness(async (tx) => await readCorrectionForRun(tx, at));
      const write = await inBusiness(
        async (tx) =>
          await recordObservedResult(tx, {
            ...at,
            step: 'publish',
            outcome: 'live',
            observations: { seen: 'live' },
          }),
      );
      expect({
        readOk: read.ok,
        writeOk: write.ok,
        state: await stateOf(id),
        receipts: await countOf(RECEIPTS, id),
      }).toStrictEqual({
        readOk: false,
        writeOk: false,
        state: 'approved',
        receipts: 0,
      });
    });
  },
);
