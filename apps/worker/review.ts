// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 in the worker. The plan's accept fires nothing: dispatch refuses a
// plan's lease `LAUNCH_NOT_DECIDED` before any mark, so the worker hands the
// work back with its successor, the reviewed output. A person's accept of that
// version is the launch, and the worker's next pass picks the launch up and
// applies it. Like the rest of the worker, this only shapes calls to the API.

/** The work handed back for review: the successor's pending gate and its version. */
export interface HandedBack {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
}

/** The reviewed output's change, as the successor names it. */
const REVIEWED_CHANGE = 'a team-only comment, reviewed; this changes nothing outside the app';

/** `task.handback`'s body: the lease's work completed, the reviewed output its successor. */
export function reviewBody(
  lease: object,
  operationId: string,
  step: { readonly kind: string; readonly payload: object },
  maximumMinor: number,
): Record<string, unknown> {
  return {
    operationId,
    ...lease,
    outcome: 'completed',
    report: { summary: 'the reviewed output, for a person to accept' },
    successor: {
      purpose: step.kind,
      maximumMinor,
      currency: 'AUD',
      payload: { change: REVIEWED_CHANGE },
      step,
    },
  };
}

/** The outcome a hand-back's answer gives: the successor's gate and version. */
export const handedBackFrom = (
  taskId: string,
  detail: Readonly<Record<string, unknown>>,
): { readonly handedBack: HandedBack } => ({
  handedBack: {
    taskId,
    gateId: String(detail['successorGateId']),
    versionId: String(detail['successorVersionId']),
  },
});
