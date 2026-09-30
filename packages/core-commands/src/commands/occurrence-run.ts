// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 J: an automation occurrence's run, created by the worker as a system
// write. Signature only; the build follows the red run.

import type { RuntimeResult } from '../../../core-runtime/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';

export type ApprovalState = 'standing' | 'revoked' | 'ended' | 'superseded';

export interface OccurrenceAuthority {
  readonly approvalId: string;
  readonly approvalState: ApprovalState;
  readonly approverActorId: string;
  readonly definitionId: string;
  readonly definitionVersionId: string;
  readonly versionState: 'released' | 'revoked';
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly clientId: string | null;
  readonly title: string;
}

export type ReadOccurrenceAuthority = (
  tx: TenantQuery,
  occurrenceId: string,
) => Promise<OccurrenceAuthority | undefined>;

export interface OccurrenceRunRequest {
  readonly occurrenceId: string;
  readonly workerActorId: string;
}

export interface OccurrenceRun {
  readonly runId: string;
  readonly taskId: string;
  readonly replayed: boolean;
}

export async function startOccurrenceRun(
  _tx: TenantQuery,
  _request: OccurrenceRunRequest,
  _readAuthority: ReadOccurrenceAuthority,
): Promise<RuntimeResult<OccurrenceRun>> {
  await Promise.resolve();
  throw new Error('startOccurrenceRun: not built');
}
