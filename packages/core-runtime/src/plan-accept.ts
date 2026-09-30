// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the plan accept, the only activation of a pinned instruction file.
//
// One person's approval of the plan's gate is the manual activation AW-02's
// pieces were built for, taken in the caller's one transaction, in this order:
//
//   1. `admitActivation`: a person's manual act, or nothing. Only a person
//      reaches this function (an agent's decision is refused by the delegation
//      check before any gate is read), and the admission is still taken here,
//      so the pin below can only be written from one.
//   2. `captureManifest`: every file the run may read, entry first, read from
//      the source before any row is written. An unreadable file or an odd path
//      is `DEFINITION_UNAVAILABLE` and the accept writes nothing.
//   3. `decide`: the approval, with its own authority check, locks, signed
//      decision and reservation. Its refusal is the accept's, and it writes
//      nothing either.
//   4. `pinBootstrapFile`: the pin on the gate's run, with the manifest beside
//      it. The entry is in the manifest by construction; if the pin cannot be
//      written the statement's error fails the transaction, so an approval
//      never commits without its pin.
//
// The plan decision authorises no effect: the effect gate is AW-08's launch.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { decide, type DecideRequest, type DecideResult, type Decided } from './decide.ts';
import {
  admitActivation,
  captureManifest,
  pinBootstrapFile,
  type FileIdentity,
  type InstructionSource,
} from './definitions.ts';
import type { RuntimeResult } from './refusals.ts';

/** A person's approval of the plan's gate, naming the files the run may read. */
export interface PlanAcceptRequest extends Omit<DecideRequest, 'decision' | 'recipientPersonId'> {
  /** The bootstrap file the run starts from. */
  readonly entryPath: string;
  /** Every other instruction file the run may read. */
  readonly paths: readonly string[];
}

export type PlanAccepted = Extract<Decided, { readonly decision: 'approve' }> & {
  readonly runId: string;
  readonly pin: FileIdentity;
  readonly manifestDigest: string;
};

/** The accept's answer: the approval with its pin, or the refusal that wrote nothing. */
export type PlanAcceptResult = RuntimeResult<PlanAccepted> | Extract<DecideResult, { ok: false }>;

export async function acceptPlan(
  tx: TenantQuery,
  request: PlanAcceptRequest,
  source: InstructionSource,
): Promise<PlanAcceptResult> {
  const admitted = admitActivation({
    mode: 'manual',
    activator: { kind: 'person', actorId: request.decidedByActorId },
  });
  if (!admitted.ok) return admitted;
  const captured = await captureManifest(source, [request.entryPath, ...request.paths]);
  if (!captured.ok) return captured;

  const decided = await decide(tx, { ...request, decision: 'approve' });
  if (!decided.ok) return decided;
  const approval = decided.value;
  if (approval.decision !== 'approve') throw new Error('acceptPlan: decide answered no approval');

  const runs = await tx.query<{ readonly run_id: string }>(
    'select run_id from public.gates where business_id = $1 and id = $2',
    [tx.businessId, approval.gateId],
  );
  const runId = runs[0]?.run_id;
  if (runId === undefined) throw new Error('acceptPlan: the approved gate has no run');
  const pinned = await pinBootstrapFile(tx, admitted.value, {
    runId,
    entryPath: request.entryPath,
    manifest: captured.value,
  });
  // The entry is the manifest's first path, so a refusal here is a fault.
  if (!pinned.ok) throw new Error('acceptPlan: the entry file is not in its own manifest');
  return {
    ok: true,
    value: { ...approval, runId, pin: pinned.value, manifestDigest: captured.value.digest },
  };
}
