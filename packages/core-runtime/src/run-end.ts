// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.end`, the worker's own stop for what only it can see (#1623 R1): an
// uncatalogued tool, a refused tool, a malformed conversation, tracing
// refused, a pinned file that changed, an answer lost after it settled, or the
// door refusing its call while its delegation is live. The worker names a
// code; the server derives the outcome and records it in this transaction.
//
// Under `acquire`: the presented lease's run, the lease, then its delegation.
// After the wait it reads the lease and its fence again, on the clock read
// inside the locked statement: a lease that moved or ran out is an ordinary
// refusal, and nothing is written. Then the outcome (`recordStop`, open-call
// precedence there) and the work retired. The command layer answers it as a
// retained terminal refusal, so the stop commits with its register row, and
// judges the login, the session and the delegation after this last wait
// (`agent-standing.ts`): one revoked or ended meanwhile rolls it all back.

import { retireAttempt, type StoppedAs } from '../../core-custody/src/index.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { isWorkerEndCode, type WorkerEndCode } from '../../core-wire/src/index.ts';
import { identityOf, type FileIdentity } from './definitions.ts';
import { configuredInstructionSource } from './instruction-root.ts';
import { leaseReason } from './lease-ownership.ts';
import { acquire } from './locks.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export interface RunEndRequest {
  readonly leaseId: string;
  readonly fence: number;
  readonly endCode: unknown;
  /** The agent holding the lease, and the delegation its credential resolved to. */
  readonly holderActorId: string;
  readonly delegationId: string;
}

const notOwned = (): RuntimeResult<never> =>
  refuse('LEASE_NOT_OWNED', leaseReason('not_owned'), 'End only the work your own lease holds.');

const notShown = (code: WorkerEndCode): RuntimeResult<never> =>
  refuse(
    'TRANSITION_NOT_PERMITTED',
    `the run's own records do not show ${code}`,
    'End the run with the code its records show, or carry on with the work.',
  );

/** The worker's stop, recorded as its attempt's outcome, with the work retired. */
export async function endRun(
  tx: TenantQuery,
  request: RunEndRequest,
): Promise<RuntimeResult<StoppedAs>> {
  const { endCode, leaseId, delegationId } = request;
  if (!isWorkerEndCode(endCode)) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'that is not a code a worker may end its run with',
      'Name one of the worker end codes; the server derives the outcome.',
    );
  }
  // Unlocked, for the lock set only: everything is read again under the locks.
  const [found] = await tx.query<{ run_id: string }>(
    'select run_id from public.leases where business_id = $1 and id = $2 and delegation_id = $3',
    [tx.businessId, leaseId, delegationId],
  );
  if (found === undefined) return notOwned();
  await acquire(tx, [
    { lockClass: 'run', id: found.run_id },
    { lockClass: 'lease', id: leaseId },
    { lockClass: 'delegation', id: delegationId },
  ]);
  const [held] = await tx.query<{ run_id: string; live: boolean }>(
    `select run_id, state = 'live' and expires_at > clock_timestamp() as live
       from public.leases
      where business_id = $1 and id = $2 and fence = $3 and holder_actor_id = $4
        and delegation_id = $5`,
    [tx.businessId, leaseId, request.fence, request.holderActorId, delegationId],
  );
  if (held === undefined) return notOwned();
  if (!held.live) {
    return refuse('LEASE_EXPIRED', leaseReason('expired'), 'Its stop is already recorded.');
  }
  if (!(await shown(tx, endCode, held.run_id, leaseId))) return notShown(endCode);
  const stopped = await retireAttempt(tx, { leaseId, delegationId }, endCode);
  if (stopped === undefined) return notOwned();
  return { ok: true, value: stopped };
}

/**
 * Whether the server's own records show the claimed code. Three need proof: a
 * lost answer or a worker's call limit follows a settled call; a definition
 * mismatch is the pinned read's own typed mismatch, read again here. The rest
 * are facts only the worker sees, and the open-call precedence decides them.
 */
async function shown(
  tx: TenantQuery,
  code: WorkerEndCode,
  runId: string,
  leaseId: string,
): Promise<boolean> {
  if (code === 'ANSWER_LOST' || code === 'CALL_LIMIT_REACHED') {
    const settled = await tx.query(
      `select 1 from public.model_calls
        where business_id = $1 and lease_id = $2 and state = 'settled' limit 1`,
      [tx.businessId, leaseId],
    );
    return settled.length > 0;
  }
  if (code === 'DEFINITION_MISMATCH') return await pinnedMismatch(tx, runId);
  return true;
}

/** The run's pinned bootstrap file, read now, differs from the identity it was pinned at. */
async function pinnedMismatch(tx: TenantQuery, runId: string): Promise<boolean> {
  const [pin] = await tx.query<{ path: string; manifest: readonly FileIdentity[] }>(
    `select path, manifest from public.run_definition_pins
      where business_id = $1 and run_id = $2 and ref_kind = 'bootstrap_file'`,
    [tx.businessId, runId],
  );
  const source = configuredInstructionSource();
  if (pin === undefined || source === undefined) return false;
  const bytes = await source.read(pin.path);
  if (bytes === undefined) return false;
  const expected = pin.manifest.find((entry) => entry.path === pin.path);
  const identity = identityOf(pin.path, bytes);
  return expected?.digest !== identity.digest || expected.size !== identity.size;
}
