// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 through the shipped worker. The plan's accept fires nothing, so the
// worker's first pass on that work hands it back for review (outcome
// `handedBack`); a person's accept of the successor it wrote is the launch,
// and the worker's next pass picks the launch up and applies it. Suites about
// what the worker does after the launch start here, each accepting through its
// own surface.

import { randomUUID } from 'node:crypto';
import type { WorkerOutcome } from '../../apps/worker/worker.ts';

export interface HandedBack {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
}

/** `task.decide`'s body for the launch: the reviewed output's own gate and version. */
export const launchBody = (handed: HandedBack): Record<string, unknown> => ({
  operationId: randomUUID(),
  gateId: handed.gateId,
  versionId: handed.versionId,
  decision: 'approve',
  note: 'launch the reviewed output',
});

/**
 * One worker pass that hands the plan's work back, then `accept` with the
 * launch's body. Throws on any other outcome; answers the reviewed output and
 * what `accept` answered.
 */
export async function launchThrough<T>(
  worker: { readonly applyOnce: (taskId: string) => Promise<WorkerOutcome> },
  taskId: string,
  accept: (body: Record<string, unknown>) => Promise<T>,
): Promise<{ readonly handed: HandedBack; readonly accepted: T }> {
  const outcome = await worker.applyOnce(taskId);
  if (!('handedBack' in outcome)) throw new Error(`hand back: ${JSON.stringify(outcome)}`);
  const handed = outcome.handedBack;
  return { handed, accepted: await accept(launchBody(handed)) };
}
