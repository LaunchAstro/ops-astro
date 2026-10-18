// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner plumbing, shared by the publish (`live-correction-runner.ts`)
// and the revert (`live-correction-revert.ts`): where the worker stands, the
// provider ports a run holds, and how a run ends: refused, recorded with its
// receipt, or waiting on a person asked once.

import {
  recordObservedResult,
  type Database,
  type LiveCorrection,
  type ObservedResult,
} from '../../../core-records/src/index.ts';
import type {
  CaptureOptions,
  ProviderResult,
  PublishPorts,
  ReadBack,
} from '../../../core-connectors/src/index.ts';
import type { Observations } from './live-correction-observations.ts';
import { pageNotCatalogued } from './live-correction-capture.ts';
import { askOnce, settleAsk } from './live-correction-effect.ts';

/** Where the worker stands: the correction, the lease and fence it holds, and its own actor. */
export interface CorrectionRun {
  readonly business: string;
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
  /** The lease's holder: the read and the receipt are refused to any other actor. */
  readonly actorId: string;
}

type Seamed = { readonly seam: string; readonly dispatchToken: string };
type Deployed = { revision: string; deploymentId: string };

/** The provider calls, each a catalogued operation through the guarded call or the fence. */
export interface RunnerPorts {
  readonly readSource: PublishPorts['readSource'];
  /** `site.source.read` of the bound file on the default branch. */
  readonly readBack: PublishPorts['readBack'];
  readonly publish: PublishPorts['publish'];
  readonly readDeployment: (
    deploymentId: string,
  ) => Promise<ProviderResult<{ revision: string; served: boolean }>>;
  /** `site.deployment.lookup` of a revision, once: its deployment, or undefined while none is found. */
  readonly findDeployment: (revision: string) => Promise<ProviderResult<string | undefined>>;
  /** `site.capture`: the C18-1 fence's own inputs, never a function handed in. */
  readonly capture: CaptureOptions;
  /** `site.source.read` of the default branch head, for a revert. */
  readonly revertReadBack: (input: Seamed) => Promise<ReadBack<Deployed>>;
  /** `site.source.revert`, under the token derived from the published revision. */
  readonly revert: (input: Seamed) => Promise<ProviderResult<Deployed>>;
  readonly raiseTask: (reason: string) => Promise<void>;
  readonly now: () => number;
  /** Every refusal and unknown the guarded calls recorded on this run, by code. */
  readonly refusals: () => readonly string[];
  /** The refusal of a correction these ports were not bound to (`bindingRefuses`), or nothing. */
  readonly unbound: (correction: LiveCorrection) => string | undefined;
}

export type RunResult =
  | { readonly kind: 'refused'; readonly code: string; readonly waitsOn?: 'person' }
  | { readonly kind: 'recorded'; readonly state: string; readonly receiptId: string }
  | { readonly kind: 'unrecorded'; readonly outcome: string; readonly code: string };

export const refused = (code: string): RunResult => ({ kind: 'refused', code });

/** A refusal that waits on a person, with its task raised. */
export async function waiting(code: string, ports: RunnerPorts): Promise<RunResult> {
  await ports.raiseTask(code);
  return { kind: 'refused', code, waitsOn: 'person' };
}

/** The lease read's refusal: a narrowed delegation waits on its person to restore the grant. */
export async function leaseRefused(code: string, ports: RunnerPorts): Promise<RunResult> {
  return code === 'DELEGATION_NARROWED' ? await waiting(code, ports) : refused(code);
}

/** An outcome nothing registered, or nothing settled: it waits on a person, asked once (`askOnce`). */
export async function unknownWaits(
  db: Database,
  run: CorrectionRun,
  at: Parameters<typeof askOnce>[2],
  ports: RunnerPorts,
  reason = 'OUTCOME_UNKNOWN',
): Promise<RunResult> {
  const asked = await askOnce(db, run, at);
  if (typeof asked === 'string') return await leaseRefused(asked, ports);
  if (asked) {
    await ports.raiseTask(reason).catch(async (error: unknown) => {
      await settleAsk(db, run, at, 'none').catch(() => null);
      throw error;
    });
    await settleAsk(db, run, at, 'person');
  }
  return { kind: 'refused', code: reason, waitsOn: 'person' };
}

/** Step 3: the observed result and its receipt, or a raised task when it cannot be written. */
export async function record(
  db: Database,
  run: CorrectionRun,
  result: Pick<ObservedResult, 'step' | 'outcome'> & { readonly observations: Observations },
  ports: RunnerPorts,
): Promise<RunResult> {
  const written = await db.withBusiness(
    run.business,
    async (tx) => await recordObservedResult(tx, { ...run, ...result }),
  );
  if (written.ok) return { kind: 'recorded', state: written.state, receiptId: written.receiptId };
  await ports.raiseTask('RECEIPT_NOT_WRITTEN');
  return { kind: 'unrecorded', outcome: result.outcome, code: written.code };
}

/** Ports bound to another correction, or a stored page the fence refuses, stop the run first. */
export async function pageRefused(
  correction: LiveCorrection,
  ports: RunnerPorts,
): Promise<RunResult | undefined> {
  const code = ports.unbound(correction) ?? pageNotCatalogued(correction.pageUrl, ports.capture);
  return code === undefined ? undefined : await waiting(code, ports);
}
