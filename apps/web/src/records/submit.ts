// SPDX-License-Identifier: AGPL-3.0-only
//
// The generic edit submission: one path from an edited field to the server, and
// the reason it is generic is that the refusals have to be reachable.
//
// **This module knows nothing about which fields are writable.** That is the
// point. The classification lives on the record type on the server, and a
// client that filtered `state` or `assignee` out of an edit before sending it
// would make `TRANSITION_PROTECTED` unreachable from the real application —
// which is exactly the case checklist N3 requires be exercised "through the
// real mounted app's generic submission module". So every field the caller
// hands over is sent, and the server decides.
//
// **The server's refusal is displayed verbatim by code.** `describeRefusal`
// composes what a person reads out of the code, the names and the fixes the
// server sent, and there is no table here mapping a code to nicer words. A
// client-side copy of the refusal vocabulary is a second vocabulary, and the
// first time the server grows a code the client would be confidently wrong
// about it.

import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
  type WireRefusal,
} from '../operations/client.ts';
import type { CommandName } from '../../../../packages/core-records/src/commands/surface.ts';

export interface SubmitRequest {
  /** The operation that owns the write. The caller names it; this does not guess. */
  readonly command: CommandName;
  readonly recordId: string;
  /** The revision the edit was made against, for the server to compare. */
  readonly expectedRevision: number;
  /** Whatever was edited. Unfiltered, on purpose. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Present on a retry of the same attempt, absent on a new one. */
  readonly operationId?: string;
}

export type SubmitResult = CallResult<CommandOutcome>;

/**
 * Send one edit.
 *
 * `task.reparent` and `task.move` take their own payload rather than `fields`,
 * so they are not submitted through here; the three screens do not reach them.
 */
export async function submitEdit(
  client: OperationsClient,
  request: SubmitRequest,
): Promise<SubmitResult> {
  const options =
    request.operationId === undefined
      ? { expectedRevision: request.expectedRevision }
      : { expectedRevision: request.expectedRevision, operationId: request.operationId };
  return client.mutate(
    request.command,
    { recordId: request.recordId, fields: request.fields },
    options,
  );
}

/**
 * What a person is shown when a submission does not succeed.
 *
 * Built from the server's own code, names and fixes. The code is always shown:
 * a refusal a person cannot quote to somebody else is a refusal they cannot get
 * help with.
 */
export function describeRefusal(refusal: WireRefusal): string {
  const named = refusal.names.length === 0 ? '' : ` (${refusal.names.join(', ')})`;
  const fixes = refusal.fixes.length === 0 ? '' : ` ${refusal.fixes.join(' ')}`;
  return `${refusal.code}${named}.${fixes}`.trim();
}

/** One line for whatever went wrong, refusal or absence, in the sender's words. */
export function describeFailure(result: SubmitResult): string | null {
  if (isRefusal(result)) return describeRefusal(result);
  if (isUnavailable(result)) return result.because;
  return null;
}
