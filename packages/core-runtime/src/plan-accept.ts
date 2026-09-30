// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the plan accept, the only activation of a pinned instruction file.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { DecideRequest, DecideResult, Decided } from './decide.ts';
import type { FileIdentity, InstructionSource } from './definitions.ts';
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
  _tx: TenantQuery,
  _request: PlanAcceptRequest,
  _source: InstructionSource,
): Promise<PlanAcceptResult> {
  await Promise.resolve();
  throw new Error('acceptPlan: not built');
}
