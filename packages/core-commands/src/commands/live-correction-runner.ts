// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's system runner: publish and revert, composed with the records. Stub.

import type { Database } from '../../../core-records/src/index.ts';
import type { ProviderResult } from '../../../core-connectors/src/index.ts';

export interface CorrectionRun {
  readonly business: string;
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
}

export type CaptureAnswer =
  { readonly ok: true; readonly value: { readonly text: string } } | { readonly ok: false };

export interface RunnerPorts {
  readonly readSource: () => Promise<ProviderResult<{ content: string; revision: string }>>;
  readonly publish: (input: {
    seam: string;
    dispatchToken: string;
    versionDigest: string;
  }) => Promise<ProviderResult<{ revision: string; deploymentId: string; liveUrl: string }>>;
  readonly readDeployment: (
    deploymentId: string,
  ) => Promise<ProviderResult<{ revision: string; served: boolean }>>;
  readonly capture: (url: string) => Promise<CaptureAnswer>;
  readonly revert: (input: {
    seam: string;
  }) => Promise<ProviderResult<{ revision: string; deploymentId: string }>>;
  readonly raiseTask: (reason: string) => Promise<void>;
  readonly now: () => number;
  readonly refusals: () => readonly string[];
}

export type RunResult =
  | { readonly kind: 'refused'; readonly code: string; readonly waitsOn?: 'person' }
  | { readonly kind: 'recorded'; readonly state: string; readonly receiptId: string }
  | { readonly kind: 'unrecorded'; readonly outcome: string; readonly code: string };

export function runLivePublish(
  _db: Database,
  _run: CorrectionRun,
  _ports: RunnerPorts,
): Promise<RunResult> {
  return Promise.resolve({ kind: 'refused', code: 'DEPENDENCY_NOT_LANDED' });
}

export function runLiveRevert(
  _db: Database,
  _run: CorrectionRun,
  _ports: RunnerPorts,
): Promise<RunResult> {
  return Promise.resolve({ kind: 'refused', code: 'DEPENDENCY_NOT_LANDED' });
}
